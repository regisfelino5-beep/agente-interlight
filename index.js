require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const { OpenAI } = require('openai');
const fs = require('fs');
// Carrega o manual inteiro na memória RAM do servidor
const manualTecnico = fs.readFileSync('manual_interlight.txt.txt', 'utf8');

const app = express();
app.use(cors());
app.use(express.json());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const pool = new Pool({ connectionString: process.env.SUPABASE_DATABASE_URL });

// ==========================================
// ESTADO PERSISTENTE (MEMÓRIA)
// ==========================================
const sessions = {};
function getSession(id) {
    if (!sessions[id]) {
        sessions[id] = { history: [], context: {} };
    }
    return sessions[id];
}

// ==========================================
// UTILITÁRIOS - SANITIZAÇÃO RADICAL
// ==========================================
function extrairCodigoBusca(mensagem) {
    let termo = mensagem;
    const lixo = [/modelo/ig, /referação/ig, /referencia/ig, /ref:/ig, /ref/ig, /peça/ig, /codigo/ig, /código/ig, /luminária/ig, /luminaria/ig];
    lixo.forEach(regex => { termo = termo.replace(regex, '') });
    // Mantém letras, números, pontos, hífens e espaços. Ex: 2153.S.PM ou Linha Flat
    return termo.replace(/[^a-zA-Z0-9.\-\s]/g, '').trim();
}

const GLOSSARIO = `SIGLAS: PM=Preto Microtexturizado, BR=Branco, MT=Metalizado.`;
const TABLE_SCHEMA = `Colunas Principais: referencia_completa, linha, tipologia, sub_tipologia, descricao, cores, potencia_w, fluxo_lum_luminaria_lm, grau_de_protecao, irc_ra_r1_r8, ies, manual`;

// ==========================================
// 1. AGENTE ROTEADOR
// ==========================================
async function agenteRoteador(mensagem) {
    console.log("🧭 [Agente Roteador] Classificando intenção...");
    const prompt = `Classifique a intenção do cliente da Interlight rigorosamente: 
- "produto_exato": Contém códigos ou referências diretas como "2153.S.PM" ou "5103" ou nomes puros de linhas.
- "produto_consultivo": Busca por aplicação em um projeto (ex: "preciso de uma luminária de piso externa").
- "conceito_tecnico": Pergunta pura sobre teoria, normas, IP67, IK, STP, como as linhas funcionam. 

Responda OBRIGATORIAMENTE JSON: { "intent": "produto_exato" ou "produto_consultivo" ou "conceito_tecnico" }`;

    const response = await openai.chat.completions.create({
        model: "gpt-4o",
        temperature: 0,
        messages: [{ role: "system", content: prompt }, { role: "user", content: mensagem }],
        response_format: { type: "json_object" }
    });
    return JSON.parse(response.choices[0].message.content).intent;
}

// ==========================================
// 2. DATA HUNTER (SQL) - BUSCA EM 3 NÍVEIS
// ==========================================
async function agenteSQLDataHunter(mensagem, termoLimpo, intent) {
    console.log(`🕵️ [Engenheiro de Dados SQL] Iniciando busca para intenção: ${intent} | termoLimpo: ${termoLimpo}`);
    let queryResult = [];
    let sqlGerado = "";

    // Se for conceito técnico puro sem fornecer uma linha ou código, pula o banco
    if (intent === "conceito_tecnico" && termoLimpo.length < 3) return { data: [], query: "N/A" };

    for (let tentativa = 1; tentativa <= 3; tentativa++) {
        let regra = "";
        if (tentativa === 1) regra = `NÍVEL 1: Busca EXATA. Identifique o código, referência ou nome da linha (Ex: Flat, 5103, 2153.S.PM) na mensagem do cliente. Crie um SELECT básico usando: WHERE referencia_completa ILIKE '%seu_termo%' OR linha ILIKE '%seu_termo%'`;
        if (tentativa === 2) regra = `NÍVEL 2: Busca PARCIAL. Identifique o melhor termo chave do pedido e crie um SELECT usando: WHERE referencia_completa ILIKE '%seu_termo%' OR descricao ILIKE '%seu_termo%'`;
        if (tentativa === 3) regra = `NÍVEL 3: Busca AMPLA. Identifique a necessidade e o tipo de luminária e crie um SELECT usando: WHERE linha ILIKE '%seu_termo%' OR tipologia ILIKE '%seu_termo%' OR usabilidade_principal ILIKE '%seu_termo%'`;

        const promptSQL = `Você é um robô gerador de SQL PostgreSQL. Retorne OBRIGATORIAMENTE E APENAS o comando SELECT válido em PostgreSQL. Sem aspas iniciais, finais ou marcação de código markdown.
        Base de Colunas Válidas: ${TABLE_SCHEMA} 
        Regra de Busca Estratégica: ${regra}
        Mensagem Original do Cliente (Extraia o termo daqui para o ILIKE): "${mensagem}"
        Retorne pelo menos as colunas referencia_completa, potencia_w, fluxo_lum_luminaria_lm, grau_de_protecao
        LIMIT 5`;

        const sqlCompletion = await openai.chat.completions.create({
            model: "gpt-4o",
            temperature: 0,
            messages: [{ role: "system", content: promptSQL }]
        });

        let sqlQuery = sqlCompletion.choices[0].message.content.replace(/```sql/ig, '').replace(/```/g, '').trim();
        sqlGerado = sqlQuery;

        if (!sqlQuery.toLowerCase().startsWith('select')) continue;

        try {
            console.log(`   [Tentativa ${tentativa}] Executando: ${sqlQuery}`);
            const dbResponse = await pool.query(sqlQuery);
            if (dbResponse.rows.length > 0) {
                queryResult = dbResponse.rows;
                console.log(`   ✅ Sucesso! Econtramos ${queryResult.length} registros.`);
                break; // Achou, para o loop!
            }
        } catch (error) {
            console.error("   ❌ Erro de Sintaxe SQL no Nível", tentativa, error.message);
        }
    }
    return { data: queryResult, query: sqlGerado };
}

// ==========================================
// 3. REDATOR/AUDITOR DE SAÍDA DE DADOS (WHATSAPP)
// ==========================================
async function agenteRedatorAuditor(mensagem, dbProdutos, intent) {
    console.log("✍️⚖️ [Redator/Auditor Engenheiro] Formatando dados para o WhatsApp...");
    const temDados = dbProdutos && dbProdutos.length > 0;

    let diretriz = `Você é um Engenheiro Consultor Especialista Interlight focado em WhatsApp e atendimento B2B/B2C. 
Seja extremamente educado, prático, objetivo e muito técnico. 
[REGRAS OBRIGATÓRIAS]
- NADA DE PROLIXIDADE. Nenhuma saudação de mais de 1 linha.
- É PROIBIDO usar adjetivos de marketing como 'design minimalista', 'elegante', 'sofisticado' se houverem dados reais. 
- Use *negrito* para destacar números técnicos e nomes estruturados (Markdown nativo do WhatsApp).`;

    if (intent === "conceito_tecnico") {
        diretriz += `\n\n[INSTRUÇÃO CRÍTICA]: O cliente fez uma pergunta conceitual ou pediu detalhes de uma linha (Ex: "Flat"). Você DEVE ler toda a string de "manualTecnico", localizar a linha ou o conceito (IP, IK) e explicá-lo cientificamente.
[MANUAL DA INTERLIGHT]:\n${manualTecnico}\n\nApós a explicação técnica, VOCÊ É OBRIGADO a mostrar os produtos encontrados na tabela abaixo (se a array não estiver vazia).\n`;
    } else if (intent === "produto_exato" && temDados) {
        diretriz += `\n\n[INSTRUÇÃO]: O cliente quer comprar. Vá DIRETO PARA A TABELA. Zero preâmbulos teóricos sobre a peça. Apresente os dados em formato WhatsApp.\n`;
    } else {
        diretriz += `\n\n[INSTRUÇÃO]: Recomende as luminárias da tabela relacionando com o pedido do cliente (ex: se pediu externa, diga o IP).\n`;
    }

    if (temDados) {
        diretriz += `\nFormate OBRIGATORIAMENTE CADA produto do array JSON usando bullet points:
- *Ref:* [referencia_completa] | *Pot:* [potencia_w] | *Fluxo:* [fluxo_lum_luminaria_lm] | *IP:* [grau_de_protecao]\n`;
    } else if (intent === "produto_exato" || intent === "produto_consultivo") {
        diretriz += `\n[INSTRUÇÃO - FALHA NA BUSCA]: Diga educadamente que não localizou a referência EXATA que ele pediu em nosso banco de dados no momento, e pergunte se ele possui mais algum detalhe do projeto (ou o CÓDIGO INTERLIGHT correto). É PROIBIDO inventar códigos.\n`;
    }

    const prompt = `${diretriz}

DADOS RETORNADOS DO BANCO DE DADOS PostgreSQL:
${JSON.stringify(dbProdutos)}

(Regra de Ouro: Se a Array acima tiver itens, você NUNCA pode dizer que 'não encontrou'. Apresente as listas. Se for um conceito_tecnico e a Array estiver vazia, foque apenas em ensinar sobre o manual.)

Cliente disse: "${mensagem}"`;

    const txtCompletion = await openai.chat.completions.create({
        model: "gpt-4o",
        temperature: 0.1,
        messages: [{ role: "system", content: prompt }]
    });

    return txtCompletion.choices[0].message.content.trim();
}

// ==========================================
// ROTA PRINCIPAL: MESA DE PRODUÇÃO N8N -> RENDER
// ==========================================
app.post('/chat', async (req, res) => {
    // Segurança com Bearer Token
    if (req.headers['authorization'] !== 'Bearer INTERLIGHT_2026_CHAT') {
        return res.status(401).json({ error: 'Acesso Negado à Mesa de Operadores.' });
    }

    const { message, sessionId = 'default_session_id' } = req.body;

    if (!message) return res.status(400).json({ error: 'A propriedade message é obrigatória no Body.' });

    console.log(`\n\n===========================================`);
    console.log(`📲 [WhatsApp Client] Mensagem Recebida: "${message}"`);

    try {
        const session = getSession(sessionId);

        // 1. Sanitização
        const termoLimpo = extrairCodigoBusca(message);
        console.log(`🧹 [Regex Cleaner] Termo Extraído: "${termoLimpo}"`);

        // 2. Roteamento de Intenção
        const intent = await agenteRoteador(message);
        console.log(`🧠 [Roteamento] Intenção Detectada: "${intent}"`);

        // 3. Orquestração de Dados Híbrida em 3 Níveis
        const sqlResult = await agenteSQLDataHunter(message, termoLimpo, intent);

        // 4. Construção Final e Auditoria de Alta Performance
        const respostaFinal = await agenteRedatorAuditor(message, sqlResult.data, intent);

        session.history.push({ role: "user", content: message }, { role: "assistant", content: respostaFinal });

        console.log(`✉️ [Outbound] Enviando resposta ao N8N com ${sqlResult.data.length} dados de catálogo.`);
        console.log(`===========================================\n`);

        return res.json({
            resposta: respostaFinal,
            _metadata: {
                orquestracao: intent,
                registros_retornados: sqlResult.data.length,
                termo_limpo_via_regex: termoLimpo,
                queryConsultada: sqlResult.query
            }
        });

    } catch (error) {
        console.error('🔥 Erro Crítico Orquestrador:', error);
        return res.status(500).json({ error: 'Erro interno na infraestrutura da mesa de produção de agentes (Render Server).' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 [Engenharia Consultiva Interlight] ONLINE na porta ${PORT} - Aguardando webhooks`);
});
