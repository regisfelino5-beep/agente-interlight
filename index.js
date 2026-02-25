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
    connectionString: process.env.SUPABASE_DATABASE_URL, // Variável segura do Render / .env
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

const SYSTEM_PROMPT = `Você é um Vendedor Técnico Objetivo e Especialista em Iluminação da Interlight.
Sua missão é atender clientes de forma direta, comercial e tecnicamente precisa, sem ser prolixo ou teórico demais.

DIRETRIZES FUNDAMENTAIS:
1. SEJA OBJETIVO: Responda de forma rápida e focada na venda e especificação técnica.
2. USO OBRIGATÓRIO DO BANCO DE DADOS: Toda recomendação técnica ou citação de produto DEVE ser validada chamando a função 'consultar_catalogo_sql' para pegar os dados reais do banco. NUNCA invente códigos (referências). NUNCA cite um produto sem olhar no banco de dados primeiro.
3. FORMATO OBRIGATÓRIO DE RESPOSTA (quando houver recomendação de produtos):
   A sua recomendação precisa ser uma resposta curta e técnica. É OBRIGATÓRIO incluir uma pequena tabela para cada produto sugerido exatamente no formato abaixo:
   Ref: [referencia_completa] | Linha: [linha] | Potência: [potencia_w] | IP: [grau_de_protecao]
4. USO DO MANUAL: Use o manual técnico fornecido apenas para dar contexto. Não transcreva o manual.

BANCO DE DADOS:
${TABLE_SCHEMA}

MANUAL TÉCNICO INTERLIGHT:
---
${manualTecnico}
---
`;

app.post('/chat', async (req, res) => {
    // 1. SEGURANÇA NA ROTA
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

        const messages = [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: message }
        ];

        // Definindo as Ferramentas (Functions) para a Inteligência Artificial
        const tools = [
            {
                type: "function",
                function: {
                    name: "consultar_catalogo_sql",
                    description: "Busca produtos no banco PostgreSQL Interlight. OBRIGATÓRIO usar quando sugerir produtos. O schema possui especificamente: referencia_completa, linha, tipologia, sub_tipologia, descricao, potencia_w, fluxo_lum_luminaria_lm, cct_k, grau_de_protecao.",
                    parameters: {
                        type: "object",
                        properties: {
                            query_sql: {
                                type: "string",
                                description: "A query SELECT para o BD. REGRA OBRIGATÓRIA: Para buscar termos (como 'balizador') busque nas colunas 'tipologia', 'sub_tipologia' ou 'usabilidade_principal' usando ILIKE ignorando acentos textualmente se puder ou contendo coringas (Ex: tipologia ILIKE '%balizador%'). Selecione SEMPRE referencia_completa, linha, potencia_w, grau_de_protecao e as demais colunas extras que precisar. Limite os resultados entre 5 e 10."
                            }
                        },
                        required: ["query_sql"]
                    }
                }
            }
        ];

        let sqlQueryGerada = null;
        let registrosEncontrados = 0;

        // =========================================================================
        // PASSO 1: Chamada Inicial para AI (Ela decide se responde direto ou se chama a Função)
        // =========================================================================
        const completion = await openai.chat.completions.create({
            model: "gpt-4o",
            temperature: 0.1, // Temperatura baixa para respostas lógicas e objetivas
            messages: messages,
            tools: tools,
            tool_choice: "auto" // A IA escolhe automaticamente chamar nossa função de banco de dados
        });

        const responseMessage = completion.choices[0].message;
        let finalAnswer = responseMessage.content;

        // =========================================================================
        // PASSO 2: A IA Clicou no Botão de Buscar no Banco de Dados (Chamou a Function Calling)
        // =========================================================================
        if (responseMessage.tool_calls && responseMessage.tool_calls.length > 0) {
            // Guarda a intenção de buscar no histórico
            messages.push(responseMessage);

            for (const toolCall of responseMessage.tool_calls) {
                if (toolCall.function.name === "consultar_catalogo_sql") {
                    const args = JSON.parse(toolCall.function.arguments);
                    let sqlQuery = args.query_sql.trim();

                    // Limpando de marcações Markdown
                    sqlQuery = sqlQuery.replace(/^```sql/, '').replace(/^```/, '').replace(/```$/, '').trim();
                    sqlQueryGerada = sqlQuery;

                    // Proteção Extra: bloqueando Delete e Update
                    if (!sqlQuery.toLowerCase().startsWith('select')) {
                        messages.push({
                            tool_call_id: toolCall.id,
                            role: "tool",
                            name: "consultar_catalogo_sql",
                            content: JSON.stringify({ error: "Query inválida. Você só tem acesso ao comando SELECT." })
                        });
                        continue; // Bloqueia e passa pro próximo
                    }

                    try {
                        console.log(`\n🔍 [Pesquisa Banco de Dados]: ${sqlQuery}\n`);
                        // Rodando o SELECT real
                        const dbResponse = await pool.query(sqlQuery);
                        const resultData = dbResponse.rows;
                        registrosEncontrados = resultData.length;

                        // Passamos o dado pra IA e instruímos o que fazer via histórico
                        messages.push({
                            tool_call_id: toolCall.id,
                            role: "tool",
                            name: "consultar_catalogo_sql",
                            content: JSON.stringify(resultData)
                        });
                    } catch (dbError) {
                        console.error('Erro na query PostgreSQL:', dbError);
                        messages.push({
                            tool_call_id: toolCall.id,
                            role: "tool",
                            name: "consultar_catalogo_sql",
                            content: JSON.stringify({ error: "Erro na leitura do BD. Fale pro usuário que houve uma instabilidade interna." })
                        });
                    }
                }
            }

            // =========================================================================
            // PASSO 3: Formata a resposta matadora de vendas final usando os produtos retornados do banco.
            // =========================================================================
            const finalCompletion = await openai.chat.completions.create({
                model: "gpt-4o",
                temperature: 0.1,
                messages: messages
            });

            finalAnswer = finalCompletion.choices[0].message.content.trim();
        }

        // Devolvendo para o n8n
        return res.json({
            resposta: finalAnswer,
            _metadata: {
                sqlQueryGerada,
                registrosEncontrados
            }
        });

    } catch (error) {
        console.error('Erro geral na rota /chat:', error);
        return res.status(500).json({ error: 'Erro interno no servidor do Render.' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
});
