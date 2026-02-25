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
// UTILITÁRIOS - EXTRATOR DE DADOS
// ==========================================
/**
 * Extrai apenas números e letras de uma mensagem de busca direta.
 * Ex: "Você tem o modelo 5103 aí?" -> "Voce tem o modelo 5103 ai"
 * Preserva o código limpo para o banco de dados.
 */
function extrairTermoBusca(mensagem) {
    // Remove pontuações que atrapalham o LIKE ou caracteres especiais
    const termoLimpo = mensagem.replace(/[^a-zA-Z0-9\s]/g, '').trim();
    return termoLimpo;
}

// ==========================================
// GLOSSÁRIO INTERNO & SCHEMA
// ==========================================
const GLOSSARIO = `
GLOSSÁRIO TÉCNICO E DE BUSCA:
- PM = Preto Microtexturizado (Busque por '%Preto%Micro%' ou '%PM%')
- BR = Branco (Busque por '%Branco%')
- MT = Misto / Metalizado
- Embutido de Solo = exige IP67, IK10 e dreno.
- Balizador = tipologia ou sub_tipologia ou usabilidade_principal ILIKE '%balizador%'
- Arandela = tipologia ILIKE '%arandela%' ou '%parede%'
`;

const TABLE_SCHEMA = `
Tabela "public"."interlight_catalog_raw"
Colunas Principais: referencia_completa, linha, tipologia, sub_tipologia, descricao, usabilidade_principal, cores, potencia_w, grau_de_protecao, cct_k, fluxo_lum_luminaria_lm
`;

// ==========================================
// AGENTES DA ORQUESTRAÇÃO ALTA PERFORMANCE
// ==========================================

/**
 * 1. AGENTE ROTEADOR
 * Identifica se é uma busca direta de código (morte ao preâmbulo), consultiva (dor do cliente) ou teoria.
 */
async function agenteRoteador(mensagem, sessionContext) {
    console.log("🧭 [Agente Roteador] Roteando intenção...");
    const prompt = `
Você é o Agente Roteador da Interlight.
Classifique a intenção do usuário:
- "produto_direto": O cliente fornece um código, referência, número ou nome da linha bem específico (ex: "5103", "luminária PM 10W", "Allinear").
- "produto_consultivo": O cliente pede sugestões para um problema ou ambiente (ex: "luz para espelho", "como iluminar passagem").
- "teoria": Quer saber sobre conceitos (ex: "o que é ofuscamento?").

Contexto Anterior: ${JSON.stringify(sessionContext)}
Nova Mensagem: "${mensagem}"

Responda OBRIGATORIAMENTE em JSON:
{
  "intent": "produto_direto" ou "produto_consultivo" ou "teoria",
  "novo_contexto": { "linha": "...", "cor": "..." } // Mantenha o contexto anterior se aplicar.
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
 * 2. CONSULTOR TÉCNICO (Manual Master)
 */
async function agenteConsultor(mensagemOriginal, termoLimpo, contextoAcumulado, intent) {
    console.log("🧙 [Consultor Técnico] Preparando specs de busca...");

    // Se for direto de código/linha, não precisa deduzir nada. Basta mandar caçar o termo puro e cru.
    if (intent === "produto_direto") {
        return `Busca direta pelo termo exato ou codigo: "${termoLimpo}". Contexto retido: ${JSON.stringify(contextoAcumulado)}`;
    }

    // Se for consultivo, ele traduz o problema
    const prompt = `
Você é o Consultor Técnico da Interlight.
Traduza o problema do cliente em parâmetros descritivos para o Especialista SQL.
${GLOSSARIO}
MANUAL: ${manualTecnico.substring(0, 1500)} // Resumo

Cliente quer: "${mensagemOriginal}"
Contexto: ${JSON.stringify(contextoAcumulado)}

Retorne APENAS um texto descritivo claro do que buscar no banco. 
Ex: "Buscar luminárias de sobrepor, cor preta, ideal para fachadas, IP65."
`;
    const response = await openai.chat.completions.create({
        model: "gpt-4o",
        temperature: 0.1,
        messages: [{ role: "system", content: prompt }]
    });
    return response.choices[0].message.content.trim();
}

/**
 * 3. ESPECIALISTA SQL (Data Hunter - 3 LEVELS FALLBACK)
 * Tenta até 3 vezes ir flexibilizando as colunas para garantir que não volte vazio.
 */
async function agenteSQLDataHunter(especificacoes) {
    console.log(`🕵️ [Agente SQL] Caçada de 3 Níveis iniciada para: ${especificacoes}`);

    let tentativa = 1;
    let queryResult = [];
    let sqlGerado = "";

    while (tentativa <= 3) {
        let instrucaoNivel = "";
        if (tentativa === 1) instrucaoNivel = "NÍVEL 1 (Exatidão): Crie a query priorizando buscar EXATAMENTE na coluna 'referencia_completa' (usando ILIKE '%termo%') ou cruzando linha e cor certas.";
        if (tentativa === 2) instrucaoNivel = "NÍVEL 2 (Linha/Tipo): O Nível 1 falhou. Abandone a busca restrita por referência exata. Busque amplamente nas colunas 'linha', 'tipologia' ou 'sub_tipologia' usando ILIKE '%termo%'.";
        if (tentativa === 3) instrucaoNivel = "NÍVEL 3 (Desespero Comercial): Nível 2 falhou! Busque de qualquer forma na coluna 'descricao' usando ILIKE ignorando acentos ou fragmentos das palavras-chave. Não volte de mãos vazias!";

        const promptSQL = `
Você é o Especialista SQL da Interlight. Retorne APENAS o comando SELECT, sem \`\`\`sql. Nenhuma aspa extra!

Pedido Técnico: ${especificacoes}
Estratégia: ${instrucaoNivel}

${GLOSSARIO}
${TABLE_SCHEMA}

Regras:
1. Retorne APENAS a string SQL! 
2. Colunas obrigatórias: referencia_completa, linha, potencia_w, grau_de_protecao, descricao, cores.
3. Use ILIKE '%termo%' para ignorar maiúsculas nas buscas de texto.
4. LIMIT 6
`;

        const sqlCompletion = await openai.chat.completions.create({
            model: "gpt-4o",
            temperature: 0.1,
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
            console.log(`   [Tentativa ${tentativa}] ${sqlQuery}`);
            const dbResponse = await pool.query(sqlQuery);
            if (dbResponse.rows.length > 0) {
                queryResult = dbResponse.rows;
                console.log(`   ✅ Achou ${queryResult.length} produto(s) no Nível ${tentativa}!`);
                break;
            } else {
                console.log(`   ⚠️ Zero achados. Escalando para Nível ${tentativa + 1}...`);
                tentativa++;
            }
        } catch (dbError) {
            console.error('   ❌ Falha de sintaxe SQL:', dbError.message);
            tentativa++; // Pula para a próxima estratégia que fará outra query
        }
    }

    return { data: queryResult, query: sqlGerado };
}

/**
 * 4. AGENTE REDATOR (Draft Builder)
 */
async function agenteRedator(mensagemCliente, dbProdutos, manual, intent) {
    console.log("✍️ [Redator] Escrevendo rascunho de venda...");

    let diretrizArquitetura = "";

    // MORTE AO PREÂMBULO PARA PRODUTO DIRETO
    if (intent === "produto_direto") {
        diretrizArquitetura = `
[ATENÇÃO - MORTE AO PREÂMBULO]: O cliente fez uma busca direta. Você está TERMINANTEMENTE PROIBIDO de iniciar com textos de conceitos ou manuais teóricos.
VÁ DIRETO AO PONTO:
1. Mostre Imediatamente a [Tabela de Produtos Reais].
2. Encerre com a [Chamada para Ação].
`;
    } else {
        diretrizArquitetura = `
ARQUITETURA:
1. [Conceito Técnico Curto]: Máximo de 1 a 2 linhas com base no manual.
2. [Tabela de Produtos Reais].
3. [Chamada para Ação].
`;
    }

    const promptRedator = `
Você é o Vendedor de Alta Performance Interlight.

${diretrizArquitetura}

Máscara da Tabela (USE EXATAMENTE ESSE FORMATO PARA CADA PRODUTO):
Ref: [referencia_completa] | Linha: [linha] | Potência: [potencia_w] | IP: [grau_de_protecao]

Produtos Encontrados:
${JSON.stringify(dbProdutos)}

(Se os produtos vierem vazios, aí sim você pode pedir a confirmação da referência educadamente)

Mensagem do Cliente: "${mensagemCliente}"
`;

    const txtCompletion = await openai.chat.completions.create({
        model: "gpt-4o",
        temperature: 0.2,
        messages: [{ role: "system", content: promptRedator }]
    });

    return txtCompletion.choices[0].message.content.trim();
}

/**
 * 5. AGENTE AUDITOR (VETO SUPREMO)
 */
async function agenteAuditor(draftResposta, dbProdutos) {
    console.log("⚖️ [Auditor] Checando bloqueios comerciais...");

    const temDados = dbProdutos && dbProdutos.length > 0;

    const promptAuditoria = `
Você é o Auditor de Vendas Interlight. Seu foco é não perder nenhuma venda.
DADOS REAIS TRAZIDOS DO BANCO (SQL): ${JSON.stringify(dbProdutos)}
O SISTEMA TEM DADOS DE PRODUTOS? ${temDados ? "SIM. VOCÊ TEM DADOS COMERCIAIS DISPONÍVEIS!" : "NÃO."}

RASCUNHO DO REDATOR:
"${draftResposta}"

REGRA DE VETO:
Se [O SISTEMA TEM DADOS DE PRODUTOS] = SIM, e o Rascunho contem a palavra "Infelizmente", "não encontrei", "não tenho" ou "não achei", o Redator enlouqueceu!
Neste caso, REJEITE SUMARIAMENTE E REESCREVA A RESPOSTA VOCÊ MESMO exibindo categoricamente os produtos usando a tabela obrigatória "Ref: [ref] | Linha: [linha] | Potência: [W] | IP: [IP]".

Se aprovado (tudo estiver certo e comercialmente perfeito), apenas devolva "aprovado: true" com o texto exato do rascunho.

JSON de Retorno OBRIGATÓRIO (sem markdown!):
{
  "aprovado": true/false,
  "resposta_corrigida": "Retorne aqui o texto final (ou a sua própria reescrita impondo a tabela de dados comerciais que foi ignorada)."
}
`;

    const auditCompletion = await openai.chat.completions.create({
        model: "gpt-4o",
        temperature: 0.1,
        messages: [{ role: "system", content: promptAuditoria }],
        response_format: { type: "json_object" }
    });

    const auditoria = JSON.parse(auditCompletion.choices[0].message.content);

    if (temDados && !auditoria.aprovado) {
        console.log(`   🚨 [VETO ATIVADO] O redator ia pedir desculpas mesmo tendo ${dbProdutos.length} produtos. A resposta foi reescrita forçadamente!`);
    } else {
        console.log(`   ✅ [Auditor] Aprovado.`);
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
    console.log(`🗣️ CLIENTE: "${message}"`);

    // Extrator de Dados: Pega as letrinhas e numerozinhos crús
    const termoLimpo = extrairTermoBusca(message);
    console.log(`🧹 TERMO LIMPO: "${termoLimpo}"`);

    try {
        const session = getSession(sessionId);

        // PASSO 1: Roteador
        const roteamento = await agenteRoteador(message, session.context);
        session.context = { ...session.context, ...roteamento.novo_contexto };
        session.history.push({ role: "user", content: message });

        console.log(`📍 Intenção: ${roteamento.intent} | Contexto:`, session.context);

        let queryResult = [];
        let metadataSQL = "";

        // PASSO 2: Consultor & Caçador de Dados
        if (roteamento.intent.includes("produto")) {
            const specsTecnicas = await agenteConsultor(message, termoLimpo, session.context, roteamento.intent);

            // O Data Hunter vai tentar 3 vezes com fallbacks (Referência -> Linha -> Descrição)
            const sqlAgentResponse = await agenteSQLDataHunter(specsTecnicas);
            queryResult = sqlAgentResponse.data;
            metadataSQL = sqlAgentResponse.query;
        }

        // PASSO 3: Redator obedecendo à regra "Morte ao Preâmbulo" caso "produto_direto"
        const rascunho = await agenteRedator(message, queryResult, manualTecnico, roteamento.intent);

        // PASSO 4: Veto Supremo do Auditor (Protege pra nunca falhar se houver produto SQL)
        const respostaFinal = await agenteAuditor(rascunho, queryResult);

        session.history.push({ role: "assistant", content: respostaFinal });

        console.log(`===========================================\n`);

        return res.json({
            resposta: respostaFinal,
            _metadata: {
                sqlQueryGerada: metadataSQL,
                registrosEncontrados: queryResult.length,
                orquestracao: "Alta Performance V2 (3-Levels + Veto)"
            }
        });

    } catch (error) {
        console.error('🔥 Erro na Orquestração Multi-Agente:', error);
        return res.status(500).json({ error: 'Erro de processamento interno no Render.' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 [Interlight Vendas de Alta Performance] ONLINE na porta ${PORT}`);
});
