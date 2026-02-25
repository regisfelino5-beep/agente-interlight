require('dotenv').config();
const { OpenAI } = require('openai');
const openai = new OpenAI();
async function test() {
    const promptSQL = `Você é um robô gerador de SQL PostgreSQL. Retorne OBRIGATORIAMENTE E APENAS o comando SELECT válido. Sem aspas iniciais, finais ou marcação markdown.
        Base de Colunas Válidas OBRIGATÓRIAS: referencia_completa, linha, potencia_w, fluxo_lum_luminaria_lm, grau_de_protecao
        Tabela Alvo: interlight_catalog_raw
        Regra: Busca EXATA. Identifique o NOME DA LINHA ou CÓDIGO (Ex: flat, 5103) na mensagem ou contexto. Crie instrução: WHERE linha ILIKE '%seu_termo_isolado%' OR referencia_completa ILIKE '%seu_termo_isolado%'
        Contexto da Conversa: []
        Mensagem do Cliente: "Quais produtos da linha DO-IT?"
        Sua reposta deve ser estritamente: SELECT referencia_completa, linha, potencia_w, fluxo_lum_luminaria_lm, grau_de_protecao FROM interlight_catalog_raw [SUA CLAUSULA WHERE AQUI]`;

    const res = await openai.chat.completions.create({
        model: 'gpt-4o', temperature: 0, messages: [{ role: 'system', content: promptSQL }]
    });
    console.log(res.choices[0].message.content);
}
test();
