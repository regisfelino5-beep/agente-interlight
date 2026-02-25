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
// Em produção no Render (sem Redis), usamos um objeto na memória RAM.
// O n8n deve mandar um "sessionId" (ex: número_do_whatsapp) para mantermos o contexto.
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
// AGENTES DA ORQUESTRAÇÃO
// ==========================================

/**
 * 1. AGENTE ROTEADOR
 * Analisa a pergunta se é teórica (manual) ou de especificação de produto,
 * e retém o contexto (State Persistent).
 */
async function agenteRoteador(mensagem, sessionContext) {
    console.log("� [Agente Roteador] Roteando intenção...");
    const prompt = `
Você é o Agente Roteador da Interlight.
Defina a intenção ("produto" ou "teoria") e extraia o contexto histórico.
Ex: Se o cliente falar de 'cor preta' e o contexto tinha 'linha Allinear', mantenha 'Allinear'.

Contexto Anterior: ${JSON.stringify(sessionContext)}
Nova Mensagem: "${mensagem}"

Responda em JSON:
{
  "intent": "produto" ou "teoria",
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
 * 2. CONSULTOR TÉCNICO (Manual Master)
 * Traduz a dor do cliente (ex: luz no chão, ofuscamento) para especificações SQL.
 */
async function agenteConsultor(mensagem, contextoAcumulado) {
    console.log("🧙 [Consultor Técnico] Traduzindo problema para linguagem de banco de dados...");
    const prompt = `
Você é o Consultor Técnico da Interlight (Manual Master).
Traduza o problema do cliente em especificações de banco de dados lendo as regras do manual.
${GLOSSARIO}

MANUAL:
${manualTecnico.substring(0, 1500)} // Resumo

Cliente quer: "${mensagem}"
Contexto retido: ${JSON.stringify(contextoAcumulado)}

Responda apenas com a frase de instrução de busca. Ex: "Buscar linha Allinear, tipologia embutido de solo, cor Preto Microtexturizado, com IP67".
`;
    const response = await openai.chat.completions.create({
        model: "gpt-4o",
        temperature: 0.1,
        messages: [{ role: "system", content: prompt }]
    });
    return response.choices[0].message.content.trim();
}

/**
 * 3. AGENTE ESPECIALISTA SQL (Data Hunter)
 * Cria a query SQL. Se falhar, tenta autonomamente buscas mais amplas (LIKE %termo%).
 */
async function agenteSQLDataHunter(especificacoes) {
    console.log(`🕵️ [Agente SQL] Preparando caçada de dados para: ${especificacoes}`);

    let tentativa = 1;
    let queryResult = [];
    let sqlGerado = "";

    // Autonomia para até 2 tentativas progressivamente mais amplas
    while (tentativa <= 2) {
        const promptSQL = `
Você é o Especialista SQL Data Hunter da Interlight.
Sua única função é gerar UMA query PostgreSQL SELECT para a tabela "public"."interlight_catalog_raw".

Pedido Técnico: ${especificacoes}
Tentativa Atual: ${tentativa} (Se for a tentativa 2, seja MUITO mais permissivo com os filtros, use ILIKE '%termo%' com curingas em várias colunas e remova filtros restritos de cor ou linha).

${GLOSSARIO}
${TABLE_SCHEMA}

REGRAS ESTABELECIDAS:
1. Retorne APENAS a string da query. Sem marcação Markdown (\`\`\`sql).
2. Selecione SEMPRE as colunas: referencia_completa, linha, potencia_w, grau_de_protecao, descricao, cores.
3. Ignore acentos usando \`unaccent()\` se disponível, ou confie no ILIKE com '%'.
4. Limite a 5 resultados.
`;

        const sqlCompletion = await openai.chat.completions.create({
            model: "gpt-4o",
            temperature: 0.1,
            messages: [{ role: "system", content: promptSQL }]
        });

        let sqlQuery = sqlCompletion.choices[0].message.content.trim();
        sqlQuery = sqlQuery.replace(/^```sql/, '').replace(/^```/, '').replace(/```$/, '').trim();
        sqlGerado = sqlQuery;

        if (!sqlQuery.toLowerCase().startsWith('select')) {
            console.error("❌ [Agente SQL] Gerou query perigosa. Abortando.");
            break;
        }

        try {
            console.log(`   [Tentativa ${tentativa}] Query: ${sqlQuery}`);
            const dbResponse = await pool.query(sqlQuery);
            if (dbResponse.rows.length > 0) {
                queryResult = dbResponse.rows;
                console.log(`   ✅ [Agente SQL] Encontrou ${queryResult.length} produto(s).`);
                break; // Achou! Sai do loop.
            } else {
                console.log(`   ⚠️ [Agente SQL] Nenhum dado encontrado. Ampliando busca...`);
                tentativa++; // Vai tentar de novo sendo mais permissivo
            }
        } catch (dbError) {
            console.error('   ❌ [Agente SQL] Erro de sintaxe na query:', dbError.message);
            tentativa++; // Errou a sintaxe, tenta gerar outra
        }
    }

    return { data: queryResult, query: sqlGerado };
}

/**
 * 4. AGENTE REDATOR (Draft Builder)
 * Monta a resposta respeitando estritamente a arquitetura de entrega exigida.
 */
async function agenteRedator(mensagemCliente, dbProdutos, manual, contexto) {
    console.log("✍️ [Agente Redator] Escrevendo a primeira versão da resposta...");
    const promptRedator = `
Você é um Vendedor Técnico Especialista da Interlight.
Você DEVE estruturar sua resposta na exata arquitetura a seguir. NENHUMA linha de código inventada é tolerada.

ARQUITETURA DE ENTREGA OBRIGATÓRIA:
1. [Conceito Técnico]: Uma frase rápida citando uma regra do manual alinhada com a requisição do cliente.
2. [Tabela de Produtos Reais]: Cada produto encontrado DEVE ser apresentado como linha nesta exata máscara:
   Ref: [referencia_completa] | Linha: [linha] | Potência: [potencia_w] | IP: [grau_de_protecao]
3. [Chamada para Ação]: Finalizar perguntando como o cliente deseja evoluir.

PRODUTOS ENCONTRADOS (ZERO ALUCINAÇÃO - Se estiver vazio, avise com elegância):
${JSON.stringify(dbProdutos)}

MANUAL DE REFERÊNCIA (Trecho):
${manual.substring(0, 1000)}

Escreva a resposta final para o cliente ("${mensagemCliente}"):
`;

    const txtCompletion = await openai.chat.completions.create({
        model: "gpt-4o",
        temperature: 0.2,
        messages: [{ role: "system", content: promptRedator }]
    });

    return txtCompletion.choices[0].message.content.trim();
}

/**
 * 5. AGENTE AUDITOR (O Revisor)
 * Avalia de forma crítica se o Redator seguiu todas as ordens e reescreve se necessário.
 */
async function agenteAuditor(draftResposta, dbProdutos) {
    console.log("⚖️ [Agente Auditor] Auditando a resposta final...");
    const promptAuditoria = `
Você é o Agente Auditor Final da Interlight, o nível mais alto de exigência de qualidade de vendas.
Revise o Rascunho abaixo.
Critérios de Aprovação:
1. Tem o bloco [Conceito Técnico] curto e profissional?
2. Tem a Tabela preenchida no formato "Ref: [ref] | Linha: [linha] | Potência: [W] | IP: [IP]" usando APENAS dados reais fornecidos? (Se a lista de produtos reais estava vazia, ele avisou civilizadamente?)
3. Tem o [Chamada para Ação]?
4. Zero invenção (alucinação) de códigos PM, referências.

Produtos Reais (como base de validação para acusar a falsa invenção):
${JSON.stringify(dbProdutos)}

Rascunho a Avaliar:
"${draftResposta}"

Sua saída DEVE OBRIGATORIAMENTE ser um JSON contendo a correção se necessário (sem blocos markdown):
{
  "aprovado": true/false,
  "resposta_corrigida": "Se aprovado, repita o rascunho igual. Se reprovado, reescreva você mesmo o texto AQUI aplicando TODAS as regras de maneira peremptória sem justificar, apenas o texto final."
}
`;

    const auditCompletion = await openai.chat.completions.create({
        model: "gpt-4o",
        temperature: 0.1,
        messages: [{ role: "system", content: promptAuditoria }],
        response_format: { type: "json_object" }
    });

    const auditoria = JSON.parse(auditCompletion.choices[0].message.content);
    console.log(`   [Agente Auditor] Aprovado? ${auditoria.aprovado}`);
    return auditoria.resposta_corrigida;
}


// ==========================================
// ROTA PRINCIPAL INVOCANDO TODOS OS AGENTES
// ==========================================
app.post('/chat', async (req, res) => {
    // 1. AUtenticação
    const token = req.headers['authorization'];
    if (token !== 'Bearer INTERLIGHT_2026_CHAT') {
        return res.status(401).json({ error: 'Acesso Negado.' });
    }

    // Opcional: O n8n pode mandar um parametro "sessionId" (ex: número do whatsapp) para contexto persistente
    const { message, sessionId = 'default_session_id' } = req.body;

    if (!message) {
        return res.status(400).json({ error: 'A propriedade "message" é obrigatória.' });
    }

    console.log(`\n\n===========================================`);
    console.log(`🗣️  NOVA MENSAGEM DO CLIENTE: "${message}"`);
    console.log(`===========================================`);

    try {
        // Carrega o Session / State
        const session = getSession(sessionId);

        // PASSO 1: O Roteador analisa intenção e atualiza Contexto Persistente
        const roteamento = await agenteRoteador(message, session.context);

        // Contexto Persistente Atualizado!
        session.context = { ...session.context, ...roteamento.novo_contexto };
        session.history.push({ role: "user", content: message });

        console.log(`📍 Intenção: ${roteamento.intent} | Contexto Persistente Atual:`, session.context);

        let queryResult = [];
        let metadataSQL = "";
        let specsTecnicas = "";

        // PASSO 2: O Consultor Técnico e Especialista SQL 
        if (roteamento.intent === 'produto') {
            specsTecnicas = await agenteConsultor(message, session.context);
            console.log(`🧠 [Especificações Traduzidas]: ${specsTecnicas}`);

            const sqlAgentResponse = await agenteSQLDataHunter(specsTecnicas);
            queryResult = sqlAgentResponse.data;
            metadataSQL = sqlAgentResponse.query;
        }

        // PASSO 3: O Redator escreve a resposta
        const rascunho = await agenteRedator(message, queryResult, manualTecnico, session.context);

        // PASSO 4: O Auditor revisa rigorosamente
        const respostaFinal = await agenteAuditor(rascunho, queryResult);

        // Atualiza memória da resposta
        session.history.push({ role: "assistant", content: respostaFinal });

        // Devolve ao n8n
        return res.json({
            resposta: respostaFinal,
            _metadata: {
                sqlQueryGerada: metadataSQL,
                registrosEncontrados: queryResult.length,
                orquestracao: "Multi-Agent Pipeline V1"
            }
        });

    } catch (error) {
        console.error('🔥 Erro na Orquestração Multi-Agente:', error);
        return res.status(500).json({ error: 'A pipeline de multi-agentes encontrou uma inconsistência.' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🧠 Servidor Multi-Agentes Orquestrado rodando na porta ${PORT}`);
});
