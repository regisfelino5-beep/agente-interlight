// test.js
async function testarAgente() {
    const pergunta = "Qual é a potência e o fluxo luminoso do projetor 2015.AB.W.BM?";

    console.log(`Enviando pergunta: "${pergunta}"\n`);

    try {
        const resposta = await fetch('http://localhost:3000/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: pergunta })
        });

        const dados = await resposta.json();
        console.log("=== RESPOSTA DO AGENTE ===");
        console.log(dados);
    } catch (erro) {
        console.error("Erro ao conectar na API:", erro);
    }
}

testarAgente();