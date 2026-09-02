# Verificacao dos campos OCPP (admin.tupimob.com) com Playwright

Script: `scripts/tupimob-ocpp-check.mjs`

Ele faz login no painel, abre `/dashboard/ocpp/transactions`, confere as colunas
da listagem contra a lista de campos OCPP esperados e (opcionalmente) abre a
pagina de um usuario para listar os campos exibidos. Gera screenshots e um
relatorio JSON em `artifacts/`.

## Instalacao

```bash
npm install                 # instala playwright (devDependency)
npx playwright install chromium
```

## Configuracao

```bash
cp .env.example .env        # preencha email/senha
```

As credenciais sao lidas de variaveis de ambiente — nada fica no codigo nem no
repositorio (`.env` e `artifacts/` estao no `.gitignore`).

## Execucao

```bash
# via .env (bash/zsh)
set -a && source .env && set +a && npm run ocpp:check

# ou direto
TUPIMOB_EMAIL=... TUPIMOB_PASSWORD=... node scripts/tupimob-ocpp-check.mjs

# navegador visivel (necessario se houver MFA/captcha)
npm run ocpp:check -- --headed --slow=250

# incluindo a pagina de um usuario
npm run ocpp:check -- --user-url="https://admin.tupimob.com/dashboard/users/<uid>?user_id=<id>"
```

Flags: `--headed`, `--slow=<ms>`, `--user-url=<url>`, `--out=<dir>`, `--timeout=<ms>`.

Se o Chromium ja estiver instalado fora do Playwright, aponte para ele com
`PLAYWRIGHT_CHROMIUM_PATH=/caminho/para/chrome` em vez de baixar outro.

## O que e verificado

Campos OCPP esperados na tabela de transacoes (cada um com sinonimos PT/EN):

| Campo | Sinonimos aceitos no cabecalho |
| --- | --- |
| ID da transacao | id, transaction, transacao, idTag |
| Carregador / Charge Point | charge point, carregador, estacao, station, charger |
| Conector | connector, conector, plug, tomada |
| Status | status, situacao, estado |
| Energia (kWh) | kWh, energia, energy, consumo, meter |
| Inicio | inicio, start, started |
| Fim | fim, stop, end, termino |
| Duracao | duracao, duration, tempo |
| Usuario | usuario, user, cliente, motorista |
| Valor / Custo | valor, custo, cost, preco, total |

Saida no terminal: `[OK]` / `[FALTA]` por campo, numero de linhas, primeira
linha de dados e um resumo dos campos ausentes.

O script tambem registra todas as respostas JSON da API durante a navegacao
(`apiLog` no relatorio) — util para ver os campos OCPP crus retornados pelo
backend, alem do que a interface renderiza.

## Ajustando os campos esperados

Edite `EXPECTED_OCPP_FIELDS` no topo de `scripts/tupimob-ocpp-check.mjs`.

## Se o login nao for encontrado

Os seletores sao tentados em cascata (`input[type=email]`, `name=email`,
placeholder etc.). Se o painel usar outro formato, o script salva
`*_login-nao-encontrado.png` em `artifacts/` — basta acrescentar o seletor
correto na lista dentro da funcao `login()`.

## Validacao ja feita

O script foi testado ponta a ponta contra um servidor local que simula o painel
(login -> tabela de transacoes -> pagina de usuario): login, leitura das colunas,
checagem `[OK]/[FALTA]` por campo, extracao dos pares rotulo/valor do usuario,
screenshots e relatorio JSON funcionaram. Falta apenas rodar contra o painel real.

## Observacao sobre execucao remota

Este script precisa alcancar `admin.tupimob.com`. Sessoes do Claude Code na web
rodam com politica de egress restrita (sem internet geral), entao ele deve ser
executado na sua maquina — ou o dominio precisa ser liberado na politica de rede
do ambiente.
