const express = require('express');
const res = require('express/lib/response');

const app = express();
const port = 8080;

app.use(express.json());

let cadastros = [
    {
        "id": "001",
        "nome": "Joana Dark",
        "telefome": "(81)9.9999-9999",
        "email": "joana.dark@gmail.com",
        "senha": "joana123@"
    },
    {
        "id": "002",
        "nome": "Albert Einstein",
        "telefome": "(81)9.9999-9998",
        "email": "albert.einstein@gmail.com",
        "senha": "albert123@"
    },
    {
        "id": "003",
        "nome": "Thomas Edson",
        "telefome": "(81)9.9999-9997",
        "email": "thomas.edson@gmail.com",
        "senha": "thomas123@"
    }
];

app.get("/cadastro", (req, res) => {
    res.json(cadastro);
});

app.post('/cadastro', (req, res) => {
    const cadastro = req.body

    console.log(cadastro);
    cadastros.push(cadastro);
    res.send('Cadastro adicionado com sucesso!');
});

app.get('/cadastro/:id', (req,res) => {
    const id = req.params.id

    for (let cadastro of cadastros) {
        if(cadastro.id === id) {
            res.json(cadastro)
            return
        }
    }
    res.status(404).send('Cadastro não encontrado!')
})

app.delete('/cadastro/:id', (req,res) => {
    const id = req.params.id

    cadastros = cadastros.filter(cadastro => {
        if (cadastro.id !== id) {
            return true;
        }
        return false;
    });
    res.send("Cadastro apagado com sucesso!");
});

app.listen(port, () => console.log("Servidor iniciado na porta ${port}"));