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

// Configuração do Supabase (via PostgreSQL client direto)
const pool = new Pool({
    connectionString: process.env.SUPABASE_DATABASE_URL,
});

const TABLE_SCHEMA = `
Tabela principal: "public"."interlight_catalog_raw"
Colunas disponíveis:
- referencia_completa
- usabilidade_principal
- usabilidade_secundaria
- tipologia
- sub_tipologia
- caracteristica_1
- caracteristica_2
- caracteristica_3
- linha
- linha_segm_1
- fonte
- lampada
- base_lampada
- potencia_w
- fluxo_lum_led_lm
- fluxo_lum_luminaria_lm
- eficacia_led
- eficacia_luminaria
- cct_k
- facho_b50
- intensidade_luminosa
- irc_ra_r1_r8
- irc_r9
- ugr
- tm30_18
- tm30_rf
- tm30_rg
- cqs
- vida_util
- sdcm
- grau_de_protecao
- led_lm_80
- classe
- tensao
- fator_de_potencia
- facho_f10
- cutoff
- d_uv
- frequencia
- subtitulo
- descricao
- material
- cores
- peso
- nicho
- acessorios
- apresentacao_da_linha
- garantia
- ies
- manual
- irc
`;

app.post('/chat', async (req, res) => {
    // 1. A TRANCA DE SEGURANÇA
    const token = req.headers['authorization'];
    if (token !== 'Bearer INTERLIGHT_2026_CHAT') {
        return res.status(401).json({ error: 'Acesso Negado. API exclusiva.' });
    }
    console.log("🔔 NOVA PERGUNTA CHEGOU DO N8N:", req.body.message);
    try {
        const { message } = req.body;

        if (!message) {
            return res.status(400).json({ error: 'A propriedade "message" é obrigatória.' });
        }

        // =========================================================================
        // PASSO 1: Interpretar a mensagem e gerar a instrução SQL SELECT
        // =========================================================================
        const sqlCompletion = await openai.chat.completions.create({
            model: "gpt-4o",
            temperature: 0,
            messages: [
                {
                    role: "system",
                    content: `Você é um assistente especialista em conversão de linguagem natural para queries SQL PostgreSQL para um catálogo de iluminação.
A sua ÚNICA função é retornar UMA QUERY SQL (apenas leitura - SELECT) com base no esquema fornecido.
Use APENAS as colunas descritas no esquema abaixo.

Regras:
1. Retorne ESTRITAMENTE o texto da query SQL. Sem blocos markdown de código (sem crases), sem explicações.
2. A query DEVE consultar a tabela "public"."interlight_catalog_raw".
3. Use cláusulas ILIKE para buscas em campos de texto de forma a ignorar case-sensitive e buscar por aproximação (ex: cores ILIKE '%Branco%').
4. Não limite em 1 resultado a não ser que o cliente peça especificamente. Mas pode usar um LIMIT razoável (ex: LIMIT 50) para evitar respostas imensas.
5. REGRA TEÓRICA (CRÍTICA): Se a pergunta pedir uma explicação, um conceito, começar com "O que é", "Como iluminar", "Qual a diferença", ou pedir dicas gerais de iluminação, NÃO BUSQUE PRODUTOS NO CATÁLOGO. Retorne ESTRITAMENTE e APENAS esta query: SELECT 'teoria' AS tipo;

6. REGRA TEÓRICA: Se a pergunta for puramente teórica e não precisar de catálogo (ex: "O que é ofuscamento?"), retorne exatamente esta query: SELECT 'teoria' AS tipo;

Esquema do Banco de Dados:
${TABLE_SCHEMA}`
                },
                {
                    role: "user",
                    content: message
                }
            ]
        });

        let sqlQuery = sqlCompletion.choices[0].message.content.trim();

        // Limpeza de possíveis formatações Markdown residuais
        sqlQuery = sqlQuery.replace(/^```sql/, '').replace(/^```/, '').replace(/```$/, '').trim();

        // Segurança: Verificar se é apenas uma query de leitura
        if (!sqlQuery.toLowerCase().startsWith('select')) {
            return res.status(400).json({ error: 'Query gerada inválida ou insegura (apenas SELECT permitido).' });
        }

        // =========================================================================
        // PASSO 2: Executar a Query no banco Supabase
        // =========================================================================
        let queryResult;
        try {
            const dbResponse = await pool.query(sqlQuery);
            queryResult = dbResponse.rows;
        } catch (dbError) {
            console.error('Erro ao executar a query SQL:', dbError);
            return res.status(500).json({ error: 'Falha ao consultar o banco de dados.' });
        }

        // =========================================================================
        // PASSO 3: Formular a resposta final pro cliente baseada nos resultados
        // =========================================================================
        const finalCompletion = await openai.chat.completions.create({
            model: "gpt-4o",
            temperature: 0,
            messages: [
                {
                    role: "system",
                    content: `Você é um Engenheiro e Lighting Designer Sênior da Interlight.
Responda a dúvida do cliente de forma elegante, didática e comercial.

PERGUNTA TEÓRICA: Se os DADOS DO CATÁLOGO retornarem [{"tipo":"teoria"}] ou se estiverem vazios devido a uma pergunta conceitual, NUNCA diga que "não encontrou produtos". Simplesmente aja como professor e explique o conceito usando APENAS o MANUAL TÉCNICO.
---
${manualTecnico}
---

BUSCA DE PRODUTOS: Se o catálogo trouxer produtos reais, cruze os conceitos do manual com os DADOS DO CATÁLOGO para recomendar as luminárias exatas:
---
${JSON.stringify(queryResult)}
---

Regra: Se o cliente fez uma pergunta teórica, baseie-se no manual. Se ele pediu produtos, cruze os conceitos do manual com os dados do catálogo para criar a recomendação perfeita.`
                },
                {
                    role: "user",
                    content: req.body.message
                }
            ]
        });

        const finalAnswer = finalCompletion.choices[0].message.content.trim();

        // Retornamos a resposta e, opcionalmente, os metadados
        return res.json({
            resposta: finalAnswer,
            _metadata: {
                sqlQueryGerada: sqlQuery,
                registrosEncontrados: queryResult.length
            }
        });

    } catch (error) {
        console.error('Erro na rota /chat:', error);
        return res.status(500).json({ error: 'Erro interno no servidor.' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
});
