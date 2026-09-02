#!/usr/bin/env node
/**
 * Verificacao automatizada (Playwright) do painel Tupimob:
 *   1. faz login em https://admin.tupimob.com/
 *   2. abre /dashboard/ocpp/transactions e confere os campos OCPP da tabela
 *   3. (opcional) abre a pagina de um usuario e extrai os campos exibidos
 *
 * Credenciais NUNCA ficam no codigo: use variaveis de ambiente (.env.example).
 *
 *   TUPIMOB_EMAIL=... TUPIMOB_PASSWORD=... node scripts/tupimob-ocpp-check.mjs
 *
 * Flags:
 *   --headed            abre o navegador visivel (util para MFA / captcha)
 *   --slow=300          atraso em ms entre acoes
 *   --user-url=<url>    pagina de usuario a inspecionar (ou TUPIMOB_USER_URL)
 *   --out=<dir>         diretorio de artefatos (padrao: ./artifacts)
 *   --timeout=60000     timeout padrao em ms
 */
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

const BASE_URL = process.env.TUPIMOB_BASE_URL || 'https://admin.tupimob.com';
const TRANSACTIONS_PATH = '/dashboard/ocpp/transactions';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v === undefined ? true : v];
  }),
);

const EMAIL = process.env.TUPIMOB_EMAIL;
const PASSWORD = process.env.TUPIMOB_PASSWORD;
const USER_URL = args['user-url'] || process.env.TUPIMOB_USER_URL || '';
const OUT_DIR = path.resolve(String(args.out || 'artifacts'));
const TIMEOUT = Number(args.timeout || 60000);

if (!EMAIL || !PASSWORD) {
  console.error('Defina TUPIMOB_EMAIL e TUPIMOB_PASSWORD no ambiente (veja .env.example).');
  process.exit(2);
}

/** Campos OCPP esperados na listagem de transacoes (rotulo -> sinonimos aceitos). */
const EXPECTED_OCPP_FIELDS = [
  ['ID da transacao', ['id', 'transaction', 'transacao', 'transacoes', 'idtag', 'id tag']],
  ['Carregador / Charge Point', ['charge point', 'chargepoint', 'carregador', 'estacao', 'station', 'charger', 'cp']],
  ['Conector', ['connector', 'conector', 'plug', 'tomada']],
  ['Status', ['status', 'situacao', 'estado']],
  ['Energia (kWh)', ['kwh', 'energia', 'energy', 'consumo', 'meter']],
  ['Inicio', ['inicio', 'start', 'comeco', 'data inicio', 'started']],
  ['Fim', ['fim', 'stop', 'end', 'termino', 'data fim', 'ended']],
  ['Duracao', ['duracao', 'duration', 'tempo']],
  ['Usuario', ['usuario', 'user', 'cliente', 'motorista', 'driver']],
  ['Valor / Custo', ['valor', 'custo', 'cost', 'preco', 'price', 'total', 'r$']],
];

const norm = (s) =>
  String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const log = (...m) => console.log('•', ...m);

async function firstVisible(page, selectors, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const sel of selectors) {
      const loc = page.locator(sel).first();
      if (await loc.isVisible().catch(() => false)) return loc;
    }
    await page.waitForTimeout(250);
  }
  return null;
}

async function shot(page, name) {
  const file = path.join(OUT_DIR, `${stamp}__${name}.png`);
  await page.screenshot({ path: file, fullPage: true }).catch(() => {});
  log('screenshot:', file);
  return file;
}

async function login(page) {
  log('abrindo', BASE_URL);
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });

  // eventual banner de cookies / consentimento
  const cookie = await firstVisible(
    page,
    ['button:has-text("Aceitar")', 'button:has-text("Accept")', 'button:has-text("Concordo")'],
    3000,
  );
  if (cookie) await cookie.click().catch(() => {});

  const emailField = await firstVisible(page, [
    'input[type="email"]',
    'input[name="email"]',
    'input[id="email"]',
    'input[name="username"]',
    'input[placeholder*="mail" i]',
    'input[placeholder*="usu" i]',
  ]);
  if (!emailField) {
    await shot(page, 'login-nao-encontrado');
    throw new Error('Campo de e-mail nao encontrado na tela de login.');
  }
  const passField = await firstVisible(page, [
    'input[type="password"]',
    'input[name="password"]',
    'input[placeholder*="senha" i]',
  ]);
  if (!passField) {
    await shot(page, 'login-sem-senha');
    throw new Error('Campo de senha nao encontrado na tela de login.');
  }

  await emailField.fill(EMAIL);
  await passField.fill(PASSWORD);
  await shot(page, '01-login-preenchido');

  const submit = await firstVisible(page, [
    'button[type="submit"]',
    'button:has-text("Entrar")',
    'button:has-text("Login")',
    'button:has-text("Acessar")',
    'input[type="submit"]',
  ]);
  if (submit) await submit.click();
  else await passField.press('Enter');

  await page
    .waitForURL(/dashboard/i, { timeout: TIMEOUT })
    .catch(() => page.waitForLoadState('networkidle', { timeout: TIMEOUT }).catch(() => {}));

  const url = page.url();
  const ok = /dashboard/i.test(url);
  await shot(page, ok ? '02-pos-login' : '02-login-falhou');
  if (!ok) throw new Error(`Login aparentemente falhou; URL atual: ${url}`);
  log('login OK ->', url);
}

/** Le a primeira tabela visivel (thead + tbody) ou, na ausencia, uma grid com role=row. */
async function readTable(page) {
  return page.evaluate(() => {
    const txt = (el) => (el?.innerText || '').replace(/\s+/g, ' ').trim();

    const table = [...document.querySelectorAll('table')].find((t) => t.offsetParent !== null);
    if (table) {
      const headers = [...table.querySelectorAll('thead th, thead td')].map(txt);
      const rows = [...table.querySelectorAll('tbody tr')]
        .slice(0, 25)
        .map((tr) => [...tr.querySelectorAll('td, th')].map(txt));
      return { kind: 'table', headers, rows, totalRows: table.querySelectorAll('tbody tr').length };
    }

    const grid = document.querySelector('[role="grid"], [role="table"]');
    if (grid) {
      const rowEls = [...grid.querySelectorAll('[role="row"]')];
      const cells = (r) => [...r.querySelectorAll('[role="columnheader"], [role="cell"], [role="gridcell"]')].map(txt);
      return {
        kind: 'grid',
        headers: rowEls.length ? cells(rowEls[0]) : [],
        rows: rowEls.slice(1, 26).map(cells),
        totalRows: Math.max(0, rowEls.length - 1),
      };
    }
    return { kind: 'none', headers: [], rows: [], totalRows: 0 };
  });
}

function checkFields(headers) {
  const normalized = headers.map(norm);
  return EXPECTED_OCPP_FIELDS.map(([label, aliases]) => {
    const hit = normalized.findIndex((h) => h && aliases.some((a) => h.includes(a)));
    return { campo: label, presente: hit >= 0, coluna: hit >= 0 ? headers[hit] : null };
  });
}

async function checkTransactions(page, apiLog) {
  const url = BASE_URL + TRANSACTIONS_PATH;
  log('abrindo', url);
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: TIMEOUT }).catch(() => {});
  await page.locator('table, [role="grid"], [role="table"]').first().waitFor({ timeout: 20000 }).catch(() => {});
  await shot(page, '03-ocpp-transactions');

  const table = await readTable(page);
  const fields = checkFields(table.headers);

  console.log('\n=== OCPP / Transacoes ===');
  console.log('URL      :', page.url());
  console.log('Estrutura:', table.kind, `| colunas: ${table.headers.length} | linhas: ${table.totalRows}`);
  console.log('Colunas  :', table.headers.join(' | ') || '(nenhuma)');
  console.log('\nCampos OCPP esperados:');
  for (const f of fields) {
    console.log(`  [${f.presente ? 'OK ' : 'FALTA'}] ${f.campo}${f.coluna ? `  -> "${f.coluna}"` : ''}`);
  }
  if (table.rows.length) {
    console.log('\nPrimeira linha:', JSON.stringify(table.rows[0]));
  } else {
    console.log('\n(nenhuma linha de dados renderizada — tabela vazia ou ainda carregando)');
  }

  return { url: page.url(), table, fields, api: apiLog.filter((r) => /ocpp|transaction/i.test(r.url)) };
}

/** Extrai pares rotulo/valor genericos de uma pagina de detalhe. */
async function readUserDetail(page) {
  return page.evaluate(() => {
    const txt = (el) => (el?.innerText || '').replace(/\s+/g, ' ').trim();
    const pairs = [];

    for (const dl of document.querySelectorAll('dl')) {
      const dts = [...dl.querySelectorAll('dt')];
      const dds = [...dl.querySelectorAll('dd')];
      dts.forEach((dt, i) => pairs.push({ rotulo: txt(dt), valor: txt(dds[i]) }));
    }
    for (const tr of document.querySelectorAll('table tr')) {
      const c = tr.querySelectorAll('td, th');
      if (c.length === 2) pairs.push({ rotulo: txt(c[0]), valor: txt(c[1]) });
    }
    for (const label of document.querySelectorAll('label')) {
      const id = label.getAttribute('for');
      const input = id ? document.getElementById(id) : label.querySelector('input, select, textarea');
      if (input) pairs.push({ rotulo: txt(label), valor: input.value ?? '' });
    }
    const seen = new Set();
    const uniq = pairs.filter((p) => {
      const k = p.rotulo + '||' + p.valor;
      if (!p.rotulo || seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    return { titulo: document.title, pares: uniq.slice(0, 120) };
  });
}

async function checkUser(page, url, apiLog) {
  log('abrindo pagina de usuario');
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: TIMEOUT }).catch(() => {});
  await shot(page, '04-usuario');

  const detail = await readUserDetail(page);
  console.log('\n=== Usuario ===');
  console.log('URL   :', page.url());
  console.log('Titulo:', detail.titulo);
  console.log(`Campos: ${detail.pares.length}`);
  for (const p of detail.pares) console.log(`  - ${p.rotulo}: ${p.valor}`);

  const ocppRelated = detail.pares.filter((p) => /ocpp|rfid|tag|carrega|charg|transac/i.test(p.rotulo));
  console.log('\nCampos relacionados a OCPP nesta pagina:', ocppRelated.length || '(nenhum)');
  for (const p of ocppRelated) console.log(`  * ${p.rotulo}: ${p.valor}`);

  return { url: page.url(), detail, api: apiLog.filter((r) => /user|ocpp/i.test(r.url)) };
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });

  const browser = await chromium.launch({
    headless: !args.headed,
    slowMo: args.slow ? Number(args.slow) : 0,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined,
  });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, locale: 'pt-BR' });
  context.setDefaultTimeout(TIMEOUT);
  const page = await context.newPage();

  /** Log das respostas JSON da API — mostra os campos OCPP crus, alem do que a UI renderiza. */
  const apiLog = [];
  page.on('response', async (res) => {
    const url = res.url();
    const ct = res.headers()['content-type'] || '';
    if (!ct.includes('json') || url.startsWith('data:')) return;
    const body = await res.text().catch(() => '');
    apiLog.push({ url, status: res.status(), sample: body.slice(0, 4000) });
  });

  const result = { executadoEm: new Date().toISOString(), baseUrl: BASE_URL };
  try {
    await login(page);
    result.transacoes = await checkTransactions(page, apiLog);
    if (USER_URL) result.usuario = await checkUser(page, USER_URL, apiLog);
    else console.log('\n(pulei a pagina de usuario: defina TUPIMOB_USER_URL ou --user-url=<url>)');

    const faltando = result.transacoes.fields.filter((f) => !f.presente);
    result.resumo = {
      colunasEncontradas: result.transacoes.table.headers.length,
      linhas: result.transacoes.table.totalRows,
      camposFaltando: faltando.map((f) => f.campo),
    };
    console.log('\n=== Resumo ===');
    console.log(
      faltando.length
        ? `Campos OCPP esperados que NAO apareceram: ${faltando.map((f) => f.campo).join(', ')}`
        : 'Todos os campos OCPP esperados foram encontrados.',
    );
  } catch (err) {
    result.erro = String(err && err.message ? err.message : err);
    console.error('\nERRO:', result.erro);
    await shot(page, '99-erro');
    process.exitCode = 1;
  } finally {
    const jsonFile = path.join(OUT_DIR, `${stamp}__relatorio.json`);
    await fs.writeFile(jsonFile, JSON.stringify({ ...result, apiLog }, null, 2), 'utf8');
    console.log('\nRelatorio:', jsonFile);
    await context.close();
    await browser.close();
  }
}

main();
