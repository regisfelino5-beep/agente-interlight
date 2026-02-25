require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const { OpenAI } = require('openai');
const fs = require('fs');

const manualTecnico = fs.readFileSync('manual_interlight.txt.txt', 'utf8');

const app = express();
app.use(cors());
app.use(express.json());

// Configuração do OpenAI
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

// Configuração do Supabase
const pool = new Pool({
    connectionString: process.env.SUPABASE_DATABASE_URL,
});

// ==========================================
// ESTADO PERSISTENTE (MEMÓRIA DE SESSÃO)
// ==========================================
const sessions = {};

function getSession(id) {
    if (!sessions[id]) {
        sessions[id] = {
            history: [],
            context: {
                linha: null,
                tipologia: null,
                ambiente: null,
                cor: null
            }
        };
    }
    return sessions[id];
}

// ==========================================
// UTILITÁRIOS - SANITIZAÇÃO RADICAL
// ==========================================
/**
 * Extrai puramente os códigos de referência, removendo verbosidades (ex: 'Modelo', 'Ref:', 'Peça').
 * Preserva hífens e pontos comuns em códigos da Interlight (ex: "2153.S.PM", "3345-S").
 */
function extrairCodigoBusca(mensagem) {
    let termoLimpo = mensagem;
    // Remove palavras-chave inúteis para a busca exata
    const lixo = [/modelo/ig, /referação/ig, /referencia/ig, /ref:/ig, /ref/ig, /peça/ig, /codigo/ig, /código/ig, /luminária/ig, /luminaria/ig];
    lixo.forEach(regex => { termoLimpo = termoLimpo.replace(regex, '') });

    // Deixa apenas letras, números, hífens, pontos e espaços
    termoLimpo = termoLimpo.replace(/[^a-zA-Z0-9.\-\s]/g, '').trim();

    return termoLimpo;
}

// ==========================================
// GLOSSÁRIO INTERNO & SCHEMA
// ==========================================
const GLOSSARIO = `
GLOSSÁRIO TÉCNICO E DE BUSCA:
- PM = Preto Microtexturizado
- BR = Branco
- MT = Misto / Metalizado
`;

const TABLE_SCHEMA = `
Tabela "public"."interlight_catalog_raw"
Colunas Principais: referencia_completa, linha, tipologia, sub_tipologia, descricao, usabilidade_principal, cores, potencia_w, fluxo_lum_luminaria_lm, grau_de_protecao, irc_ra_r1_r8, ies, manual
`;

// ==========================================
// AGENTES DA ORQUESTRAÇÃO - CONSULTOR ESPECIALISTA
// ==========================================

/**
 * 1. AGENTE ROTEADOR
 * Define se a intenção é busca de código direto, consultoria técnica ou teoria vazia.
 */
async function agenteRoteador(mensagem, sessionContext) {
    console.log("🧭 [Agente Roteador] Classificando perfil de consultoria...");
    const prompt = `
Você é o Agente Roteador da Interlight.
Classifique a intenção do usuário:
- "produto_direto": O cliente fornece um código técnico ou referência (ex: "2153.S.PM", "preciso do modelo 5103").
- "produto_consultivo": O cliente pede sugestões para resolver uma dor (ex: "luminária de piso externa").
- "teoria": Quer saber teoria sobre luz ou ofuscamento.

Contexto Anterior: ${JSON.stringify(sessionContext)}
Nova Mensagem: "${mensagem}"

Responda OBRIGATORIAMENTE em JSON:
{
  "intent": "produto_direto" ou "produto_consultivo" ou "teoria",
  "novo_contexto": { "linha": "...", "cor": "..." }
}
`;
    const response = await openai.chat.completions.create({
        model: "gpt-4o",
        temperature: 0,
        messages: [{ role: "system", content: prompt }],
        response_format: { type: "json_object" }
    });
    return JSON.parse(response.choices[0].message.content);
}

/**
 * 2. CONSULTOR TÉCNICO
 * Prepara o payload para o SQL. Se for busca de código, ele manda caçar direto sem palestrinha.
 */
async function agenteConsultor(mensagemOriginal, termoLimpo, contextoAcumulado, intent) {
    console.log("🧙 [Consultor Técnico] Formatando parâmetros técnicos...");

    if (intent === "produto_direto") {
        return `Busca técnica EXATA ou PARCIAL pela referência/código limpo: "${termoLimpo}". Regra: Zero preâmbulo teórico, apenas extração de dados brutos.`;
    }

    const prompt = `
Você é o Consultor Especialista em Iluminação da Interlight.
Traduza o problema do cliente em parâmetros descritivos rigorosos para o banco.
${GLOSSARIO}
MANUAL: ${manualTecnico.substring(0, 1500)} // Resumo

Cliente quer: "${mensagemOriginal}"
Contexto: ${JSON.stringify(contextoAcumulado)}

Retorne APENAS um texto descritivo técnico do que buscar no banco. 
Ex: "Buscar luminárias de sobrepor, IP65, cor branca."
`;
    const response = await openai.chat.completions.create({
        model: "gpt-4o",
        temperature: 0.1,
        messages: [{ role: "system", content: prompt }]
    });
    return response.choices[0].message.content.trim();
}

/**
 * 3. ESPECIALISTA SQL (Busca Híbrida 3 Níveis de Exatidão)
 */
async function agenteSQLDataHunter(especificacoes) {
    console.log(`🕵️ [Engenheiro de Dados] Iniciando rastreamento de 3 Níveis para: ${especificacoes}`);

    let tentativa = 1;
    let queryResult = [];
    let sqlGerado = "";

    while (tentativa <= 3) {
        let instrucaoNivel = "";
        if (tentativa === 1) instrucaoNivel = "NÍVEL 1 (Exatidão Máxima): Crie a query priorizando a busca EXATA na coluna 'referencia_completa'. Use \`referencia_completa = 'termo'\` ou um ILIKE ultra restrito.";
        if (tentativa === 2) instrucaoNivel = "NÍVEL 2 (Exatidão Parcial): Nível 1 falhou. Busque por fragmentos do código na coluna 'referencia_completa' usando ILIKE '%termo%'.";
        if (tentativa === 3) instrucaoNivel = "NÍVEL 3 (Busca Consultiva): Nível 2 falhou. Procure amplamente nas colunas 'linha', 'tipologia', ou 'usabilidade_principal' usando palavras-chave extraídas da intenção do cliente.";

        const promptSQL = `
Você é o Especialista de Dados da Interlight. Retorne APENAS o comando SELECT, sem \`\`\`sql. Nenhuma aspa extra!

Requisito Técnico: ${especificacoes}
Estratégia de Busca: ${instrucaoNivel}

${GLOSSARIO}
${TABLE_SCHEMA}

Regras Mandatórias:
1. Retorne APENAS a query! 
2. Colunas EXIGIDAS: referencia_completa, linha, potencia_w, fluxo_lum_luminaria_lm, grau_de_protecao, irc_ra_r1_r8, ies, manual, descricao, cores.
3. LIMIT 6
`;

        const sqlCompletion = await openai.chat.completions.create({
            model: "gpt-4o",
            temperature: 0, // Precisão absoluta no SQL
            messages: [{ role: "system", content: promptSQL }]
        });

        let sqlQuery = sqlCompletion.choices[0].message.content.trim();
        sqlQuery = sqlQuery.replace(/^```sql/i, '').replace(/^```/, '').replace(/```$/i, '').trim();
        sqlGerado = sqlQuery;

        if (!sqlQuery.toLowerCase().startsWith('select')) {
            console.error("❌ SQL Inválido.");
            break;
        }

        try {
            console.log(`   [Tentativa ${tentativa}] Query: ${sqlQuery}`);
            const dbResponse = await pool.query(sqlQuery);
            if (dbResponse.rows.length > 0) {
                queryResult = dbResponse.rows;
                console.log(`   ✅ Sucesso! Encontrou ${queryResult.length} produto(s) no Nível ${tentativa}.`);
                break;
            } else {
                console.log(`   ⚠️ Sem dados. Escalando protocolo para Nível ${tentativa + 1}...`);
                tentativa++;
            }
        } catch (dbError) {
            console.error('   ❌ Falha de sintaxe SQL:', dbError.message);
            tentativa++;
        }
    }

    return { data: queryResult, query: sqlGerado };
}

/**
 * 4. AGENTE MONTADOR DE DADOS (Technical Drafter)
 */
async function agenteRedator(mensagemCliente, dbProdutos, manual, intent) {
    console.log("✍️ [Drafting] Montando relatório técnico...");

    let diretrizArquitetura = "";

    // Sem palestrinha se foi busca por código
    if (intent === "produto_direto") {
        diretrizArquitetura = `
[PROIBIÇÃO DE TEORIA]: O cliente enviou um código de produto específico (produto_direto). 
VOCÊ ESTÁ ABSOLUTAMENTE PROIBIDO de iniciar a mensagem com aulas, regras do manual, saudações longas ou conceitos teóricos.
Vá DIRETO aos dados técnicos do produto. 

Obrigatório:
1. [Análise Técnica Curta]: Vá direto ao ponto ("O modelo X é um produto...").
2. [Tabela de Dados].
`;
    } else {
        diretrizArquitetura = `
[CONSULTORIA TÉCNICA]:
1. [Análise Técnica Curta]: Use as regras de luminosidade do manual (máx 2 linhas).
2. [Tabela de Dados].
`;
    }

    const promptRedator = `
Você é o Consultor Técnico Especialista Master da Interlight. A precisão do dado é seu objetivo.

${diretrizArquitetura}

Máscara OBRIGATÓRIA da Tabela (Construa exatamente linha por linha para CADA produto): 
Ref: [referencia_completa] | Linha: [linha] | Pot: [potencia_w] | Fluxo: [fluxo_lum_luminaria_lm] | IP: [grau_de_protecao] | IRC: [irc_ra_r1_r8] | Man: [manual] | IES: [ies]

Dados Recuperados do BD:
${JSON.stringify(dbProdutos)}

Mensagem do Cliente: "${mensagemCliente}"

Se "Dados Recuperados" estiver vazio, seja claro, mas evite desculpas emotivas.
`;

    const txtCompletion = await openai.chat.completions.create({
        model: "gpt-4o",
        temperature: 0.1,
        messages: [{ role: "system", content: promptRedator }]
    });

    return txtCompletion.choices[0].message.content.trim();
}

/**
 * 5. AGENTE AUDITOR DE DADOS (Bloqueio de Falso Negativo)
 */
async function agenteAuditor(draftResposta, dbProdutos) {
    console.log("⚖️ [Auditor] Validando dados e censurando jargões fracos...");

    const temDados = dbProdutos && dbProdutos.length > 0;

    const promptAuditoria = `
Você é o Agente Supervisor de Qualidade.
DADOS REAIS: ${JSON.stringify(dbProdutos)}
O SISTEMA TROUXE DADOS? ${temDados ? "SIM. VOCÊ TEM DADOS TÉCNICOS." : "NÃO."}

RASCUNHO A AVALIAR:
"${draftResposta}"

REGRA DE BLOQUEIO DE ERRO:
Se [O SISTEMA TROUXE DADOS?] = SIM, e o Rascunho contem a palavra "Infelizmente", "não encontrei", "desculpe" ou qualquer jargão de frustração, o Redator cometeu uma falha crítica.
Neste caso, REJEITE o rascunho e reescreva-o exibindo friamente a tabela de dados técnicos conforme a máscara "Ref: [ref] | Linha: [linha] | Pot: [potencia_w] | Fluxo: [fluxo_lum_luminaria_lm] | IP: [grau_de_protecao] | IRC: [irc_ra_r1_r8] | Man: [manual] | IES: [ies]" usando OS DADOS REAIS da linha e os links.

Não use Markdown (\`\`\`json). Retorne apenas:
{
  "aprovado": true/false,
  "resposta_corrigida": "Retorne aqui o rascunho exato original ou a sua reescrita de correção."
}
`;

    const auditCompletion = await openai.chat.completions.create({
        model: "gpt-4o",
        temperature: 0,
        messages: [{ role: "system", content: promptAuditoria }],
        response_format: { type: "json_object" }
    });

    const auditoria = JSON.parse(auditCompletion.choices[0].message.content);

    if (temDados && !auditoria.aprovado) {
        console.log(`   🚨 [CENSURA ATIVADA] O supervisor bloqueou um falso negativo. Forçando a entrega dos ${dbProdutos.length} produtos.`);
    } else {
        console.log(`   ✅ [Auditor] Conformidade OK.`);
    }

    return auditoria.resposta_corrigida;
}


// ==========================================
// ROTA PRINCIPAL INVOCANDO TODOS OS AGENTES
// ==========================================
app.post('/chat', async (req, res) => {
    const token = req.headers['authorization'];
    if (token !== 'Bearer INTERLIGHT_2026_CHAT') {
        return res.status(401).json({ error: 'Acesso Negado.' });
    }

    const { message, sessionId = 'default_session_id' } = req.body;

    if (!message) {
        return res.status(400).json({ error: 'A propriedade "message" é obrigatória.' });
    }

    console.log(`\n\n===========================================`);
    console.log(`🗣️ CLIENTE PEDE: "${message}"`);

    // Sanitização Radical - Extrai códigos limpos removendo "modelo", "ref:", etc.
    const termoLimpo = extrairCodigoBusca(message);
    console.log(`🧹 CÓDIGO/TERMO TRATADO: "${termoLimpo}"`);

    try {
        const session = getSession(sessionId);

        // PASSO 1: Roteador
        const roteamento = await agenteRoteador(message, session.context);
        session.context = { ...session.context, ...roteamento.novo_contexto };
        session.history.push({ role: "user", content: message });

        console.log(`📍 Intenção de Consultoria: ${roteamento.intent} | Contexto Técnico:`, session.context);

        let queryResult = [];
        let metadataSQL = "";

        // PASSO 2: Preparar Busca (Tradução ou Acesso Direto)
        if (roteamento.intent.includes("produto")) {
            const specsTecnicas = await agenteConsultor(message, termoLimpo, session.context, roteamento.intent);

            // PASSO 3: Eng. de Dados -> Busca Híbrida 3 Níveis exatos/parciais
            const sqlAgentResponse = await agenteSQLDataHunter(specsTecnicas);
            queryResult = sqlAgentResponse.data;
            metadataSQL = sqlAgentResponse.query;
        }

        // PASSO 4: Drafting da Tabela de Engenharia (Proibição de Aula caso Direto)
        const rascunho = await agenteRedator(message, queryResult, manualTecnico, roteamento.intent);

        // PASSO 5: Acesso de Conformidade c/ Bloqueio de Erro Genérico
        const respostaFinal = await agenteAuditor(rascunho, queryResult);

        session.history.push({ role: "assistant", content: respostaFinal });

        console.log(`===========================================\n`);

        return res.json({
            resposta: respostaFinal,
            _metadata: {
                sqlQueryGerada: metadataSQL,
                registrosEncontrados: queryResult.length,
                orquestracao: "Consultor Técnico Exato (3 Níveis Híbridos)"
            }
        });

    } catch (error) {
        console.error('🔥 Erro Crítico no Sistema:', error);
        return res.status(500).json({ error: 'Erro de processamento interno no Engine Interlight.' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 [Interlight Consultoria Exata] ONLINE na porta ${PORT}`);
});
