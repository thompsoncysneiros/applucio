# Acesso aos dados da Tupi (OCPI 2.2.1)

Cliente e CLI para os tres endpoints documentados em *TUPI — Documentacao das APIs*.

- `src/tupi/client.mjs` — cliente reutilizavel (paginacao, retry, envelope OCPI, mascaramento)
- `bin/tupi.mjs` — linha de comando

Sem dependencias: usa o `fetch` nativo do Node 18+.

## Configuracao

```bash
cp .env.example .env      # preencha TUPI_OCPI_TOKEN e TUPI_PARTY_ID
set -a && source .env && set +a
```

O token e o `party_id` nunca aparecem no codigo — so no `.env`, que esta no `.gitignore`.

## Comandos

```bash
node bin/tupi.mjs probe
# testa token, versao e escopo nos dois endpoints de listagem

node bin/tupi.mjs locations --all --out=locations.json
# estacoes, EVSEs, conectores e potencia maxima

node bin/tupi.mjs sessions --all --from=2026-08-01T00:00:00Z --csv=sessoes.csv
# sessoes com kWh, custo e status; totaliza energia e valor

node bin/tupi.mjs user-data BR-ZAR-SESS-0001
# dados do titular da sessao (mascarados; --raw mostra em claro)
```

Flags: `--all` (percorre todas as paginas), `--limit=N`, `--from=ISO`, `--to=ISO`,
`--out=arquivo.json`, `--csv=arquivo.csv`, `--raw`.

## Usando o cliente em codigo

```js
import { clienteDoAmbiente } from './src/tupi/client.mjs';

const tupi = clienteDoAmbiente();

// uma pagina
const { data, paginacao } = await tupi.sessions({ limit: 20, dateFrom: '2026-08-01T00:00:00Z' });

// todas as paginas, sob demanda
for await (const { itens } of tupi.paginar('sessions', { limit: 100 })) {
  for (const s of itens) console.log(s.id, s.kwh, s.status);
}

// tudo de uma vez
const { itens, total } = await tupi.coletarTudo('locations');

// titular de uma sessao
const dados = await tupi.userData('BR-ZAR-SESS-0001');
```

## O que o cliente resolve por voce

| Comportamento | Detalhe |
| --- | --- |
| Envelope OCPI | `status_code != 1000` vira `TupiApiError`, com `status_message` |
| Paginacao | segue `Link: rel="next"`; sem o header, avanca por `offset` ate `X-Total-Count` |
| Retry | backoff exponencial em `429`, `5xx` e falha de rede |
| Sem retry | `400`, `401`, `403`, `404`, `422` — repetir so queima requisicao |
| Timeout | 30s por requisicao (`AbortSignal.timeout`) |
| Dado pessoal | `mascararUserData()` esconde CPF, e-mail, telefone e endereco na saida |

## Limites conhecidos da API

Sao do lado da Tupi, nao do cliente:

- **Somente leitura e somente pull** — nenhum webhook. Atualizacao depende de polling.
- **Sem CDRs e sem tarifas** — o custo disponivel e o `total_cost` da sessao; nao ha como
  recalcular nem resolver os `tariff_ids`.
- **`user-data` e uma chamada por sessao** — sem busca em lote.
- **`location_id` e `evse_uid` sao o `stationID` "por enquanto"** (dito na documentacao) —
  nao use como chave estavel.
- **Filtros disponiveis**: apenas `limit`, `offset`, `date_from`, `date_to`.
- Fixe a versao em **2.2.1**: em 2.2 tipos de conector viram `TESLA_S`, potencia vira
  `AC_1_PHASE` e a capability `START_SESSION_CONNECTOR_REQUIRED` desaparece.

## Validacao

O cliente e a CLI foram exercitados ponta a ponta contra um servidor local que implementa o
contrato da documentacao: paginacao por `Link` (duas paginas), envelope OCPI, `user-data` com
mascaramento e falha `401` sem retry (147 ms). Falta apenas rodar contra a API real.
