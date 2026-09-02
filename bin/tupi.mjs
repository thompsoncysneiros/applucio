#!/usr/bin/env node
/**
 * CLI da API Tupi (OCPI 2.2.1).
 *
 *   node bin/tupi.mjs probe
 *   node bin/tupi.mjs locations [--all] [--limit=50] [--out=arquivo.json]
 *   node bin/tupi.mjs sessions  [--all] [--from=ISO] [--to=ISO] [--csv=arquivo.csv] [--out=arquivo.json]
 *   node bin/tupi.mjs user-data <session_id> [--raw]
 *
 * Credenciais vem do ambiente (veja .env.example):
 *   TUPI_OCPI_TOKEN, TUPI_PARTY_ID, TUPI_COUNTRY_CODE, TUPI_OCPI_BASE, TUPI_OCPI_VERSION
 */
import fs from 'node:fs/promises';
import { clienteDoAmbiente, mascararUserData, TupiApiError } from '../src/tupi/client.mjs';

const [, , comando, ...resto] = process.argv;
const posicionais = resto.filter((a) => !a.startsWith('--'));
const flags = Object.fromEntries(
  resto.filter((a) => a.startsWith('--')).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v === undefined ? true : v];
  }),
);

const num = (v, padrao) => (v === undefined ? padrao : Number(v));
const fmt = (n) => new Intl.NumberFormat('pt-BR').format(n);

function exigirToken() {
  if (!process.env.TUPI_OCPI_TOKEN) {
    console.error('Defina TUPI_OCPI_TOKEN (e TUPI_PARTY_ID para user-data). Veja .env.example.');
    process.exit(2);
  }
}

async function salvar(caminho, dados) {
  await fs.writeFile(caminho, JSON.stringify(dados, null, 2), 'utf8');
  console.log(`\nJSON salvo em ${caminho}`);
}

/* --------------------------------- probe --------------------------------- */

async function probe(cli) {
  console.log(`Base: ${cli.baseUrl} | versao OCPI: ${cli.version} | party: ${cli.partyId || '(nao definido)'}\n`);
  for (const recurso of ['locations', 'sessions']) {
    process.stdout.write(`${recurso.padEnd(10)} `);
    try {
      const r = await cli.get(cli.montarUrl(`/${cli.version}/${recurso}`, { limit: 1, offset: 0 }));
      const n = Array.isArray(r.data) ? r.data.length : 0;
      console.log(
        `OK — HTTP ${r.http}, status_code ${r.envelope.status_code}, ` +
        `total: ${r.paginacao.total != null ? fmt(r.paginacao.total) : 'nao informado'}` +
        (n ? `, primeiro id: ${r.data[0].id}` : ', nenhum item visivel para este token'),
      );
    } catch (e) {
      const dica = e.http === 401 ? ' → token invalido, expirado ou sem permissao para esta party'
        : e.http === 404 ? ' → caminho inexistente nesta versao'
        : '';
      console.log(`FALHOU — ${e.message}${dica}`);
    }
  }
  console.log('\nO escopo do token define quais estacoes e sessoes aparecem. Zero itens com HTTP 200 significa token valido sem dados atribuidos.');
}

/* ------------------------------- locations ------------------------------- */

async function locations(cli) {
  const limit = num(flags.limit, 50);
  const todas = [];
  for await (const p of cli.paginar('locations', { limit, maxPaginas: flags.all ? Infinity : 1 })) {
    console.log(`Pagina ${p.pagina}: ${p.itens.length} localizacao(oes)` +
      (p.paginacao.total != null ? ` de ${fmt(p.paginacao.total)}` : ''));
    todas.push(...p.itens);
  }
  console.log(`\n${todas.length} localizacao(oes):`);
  for (const l of todas) {
    const evses = l.evses ?? [];
    const conectores = evses.flatMap((e) => e.connectors ?? []);
    const potencia = conectores.reduce((m, c) => Math.max(m, c.max_electric_power ?? 0), 0);
    console.log(`  ${l.id}  ${l.name ?? '(sem nome)'} — ${l.city ?? '?'}/${l.country ?? '?'}`);
    console.log(`    ${evses.length} EVSE(s), ${conectores.length} conector(es)` +
      (potencia ? `, ate ${fmt(potencia / 1000)} kW` : '') +
      `  [${evses.map((e) => e.status).join(', ') || 'sem status'}]`);
  }
  if (flags.out) await salvar(String(flags.out), todas);
}

/* -------------------------------- sessions ------------------------------- */

const COLUNAS_CSV = [
  'id', 'status', 'start_date_time', 'end_date_time', 'kwh', 'currency',
  'cost_excl_vat', 'cost_incl_vat', 'auth_method', 'location_id', 'evse_uid',
  'connector_id', 'meter_id', 'last_updated',
];

const paraLinha = (s) => [
  s.id, s.status, s.start_date_time, s.end_date_time ?? '', s.kwh, s.currency,
  s.total_cost?.excl_vat ?? '', s.total_cost?.incl_vat ?? '', s.auth_method,
  s.location_id, s.evse_uid, s.connector_id, s.meter_id ?? '', s.last_updated,
];

const csvEscapar = (v) => {
  const t = String(v ?? '');
  return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
};

async function sessions(cli) {
  const limit = num(flags.limit, 50);
  const params = { limit, maxPaginas: flags.all ? Infinity : 1 };
  if (flags.from) params.dateFrom = String(flags.from);
  if (flags.to) params.dateTo = String(flags.to);

  const todas = [];
  for await (const p of cli.paginar('sessions', params)) {
    console.log(`Pagina ${p.pagina}: ${p.itens.length} sessao(oes)` +
      (p.paginacao.total != null ? ` de ${fmt(p.paginacao.total)}` : ''));
    todas.push(...p.itens);
  }

  const energia = todas.reduce((t, s) => t + (Number(s.kwh) || 0), 0);
  const custo = todas.reduce((t, s) => t + (Number(s.total_cost?.incl_vat ?? s.total_cost?.excl_vat) || 0), 0);
  const porStatus = todas.reduce((acc, s) => ((acc[s.status] = (acc[s.status] || 0) + 1), acc), {});

  console.log(`\n${todas.length} sessao(oes) | ${energia.toFixed(2)} kWh | ${custo.toFixed(2)} ${todas[0]?.currency ?? ''}`);
  console.log('Por status:', Object.entries(porStatus).map(([k, v]) => `${k}=${v}`).join(', ') || '—');
  console.log('\n' + ['sessao', 'status', 'kWh', 'custo', 'inicio'].join('\t'));
  for (const s of todas.slice(0, 20)) {
    console.log([
      s.id, s.status, Number(s.kwh).toFixed(2),
      (s.total_cost?.incl_vat ?? s.total_cost?.excl_vat ?? 0).toFixed(2),
      s.start_date_time,
    ].join('\t'));
  }
  if (todas.length > 20) console.log(`... e mais ${todas.length - 20}`);

  if (flags.csv) {
    const linhas = [COLUNAS_CSV.join(','), ...todas.map((s) => paraLinha(s).map(csvEscapar).join(','))];
    await fs.writeFile(String(flags.csv), linhas.join('\n') + '\n', 'utf8');
    console.log(`\nCSV salvo em ${flags.csv}`);
  }
  if (flags.out) await salvar(String(flags.out), todas);
}

/* -------------------------------- user-data ------------------------------ */

async function userData(cli) {
  const sessionId = posicionais[0];
  if (!sessionId) {
    console.error('Uso: node bin/tupi.mjs user-data <session_id> [--raw]');
    process.exit(2);
  }
  const d = await cli.userData(sessionId);
  const ud = flags.raw ? d.user_data : mascararUserData(d.user_data);
  console.log(`Sessao ${d.session_id}${flags.raw ? '' : '  (dados mascarados; --raw para ver)'}\n`);
  for (const [k, v] of Object.entries(ud ?? {})) {
    if (k === 'cars') {
      for (const c of v ?? []) console.log(`  veiculo: ${c.brand} ${c.model} — ${c.capacity} kWh, ${c.autonomy} km`);
    } else {
      console.log(`  ${k.padEnd(12)} ${v}`);
    }
  }
  if (!flags.raw) console.log('\nDado pessoal (LGPD): busque apenas com finalidade definida e nao replique em ambiente de teste.');
}

/* ---------------------------------- main --------------------------------- */

const COMANDOS = { probe, locations, sessions, 'user-data': userData };

async function main() {
  if (!comando || !COMANDOS[comando]) {
    console.log(`Comandos: ${Object.keys(COMANDOS).join(', ')}\n\n` +
      '  probe                              testa token, versao e escopo\n' +
      '  locations [--all] [--out=f.json]   estacoes, EVSEs e conectores\n' +
      '  sessions  [--all] [--from=ISO] [--to=ISO] [--csv=f.csv] [--out=f.json]\n' +
      '  user-data <session_id> [--raw]     dados do titular da sessao\n');
    process.exit(comando ? 2 : 0);
  }
  exigirToken();
  const cli = clienteDoAmbiente();
  await COMANDOS[comando](cli);
}

main().catch((e) => {
  if (e instanceof TupiApiError) {
    console.error(`\nERRO ${e.http ?? ''} ${e.ocpiStatus ? `(OCPI ${e.ocpiStatus})` : ''} — ${e.message}`);
    if (e.http === 401) console.error('Token invalido, expirado ou sem permissao para esta party.');
  } else {
    console.error('\nERRO:', e.message);
  }
  process.exit(1);
});
