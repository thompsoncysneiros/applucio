/**
 * Cliente da API Tupi (OCPI 2.2.1).
 *
 * Endpoints documentados em "TUPI — Documentacao das APIs":
 *   GET {base}/{version}/locations
 *   GET {base}/{version}/sessions
 *   GET {base}/extra/v1/sessions/{country_code}/{party_id}/{session_id}/user-data
 *
 * Todas as respostas vem no envelope OCPI: { data, status_code, status_message, timestamp }.
 * status_code 1000 = sucesso; qualquer outro vira TupiApiError.
 */

export class TupiApiError extends Error {
  constructor(mensagem, { http, ocpiStatus, ocpiMessage, url, corpo } = {}) {
    super(mensagem);
    this.name = 'TupiApiError';
    this.http = http;
    this.ocpiStatus = ocpiStatus;
    this.ocpiMessage = ocpiMessage;
    this.url = url;
    this.corpo = corpo;
  }
}

/** Erros que nao adianta repetir: credencial, permissao, validacao, inexistente. */
const HTTP_SEM_RETRY = new Set([400, 401, 403, 404, 422]);
const VERSOES = ['2.2.1', '2.2'];

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

/** Le o header Link e devolve a URL de rel="next", se houver. */
export function proximaPagina(headerLink) {
  if (!headerLink) return null;
  for (const parte of headerLink.split(',')) {
    const m = parte.match(/<([^>]+)>\s*;\s*rel\s*=\s*"?next"?/i);
    if (m) return m[1];
  }
  return null;
}

export class TupiOcpiClient {
  /**
   * @param {object} opcoes
   * @param {string} opcoes.token       Token fornecido pela Tupi (enviado como esta).
   * @param {string} [opcoes.baseUrl]   Padrao: https://ocpi.tupinrg.app
   * @param {string} [opcoes.version]   "2.2.1" (recomendada) ou "2.2" (deprecada).
   * @param {string} [opcoes.countryCode] Padrao "BR" — usado no endpoint de user-data.
   * @param {string} [opcoes.partyId]   Party ID de 3 letras da empresa.
   * @param {number} [opcoes.timeoutMs] Padrao 30000.
   * @param {number} [opcoes.maxRetries] Padrao 3 (so para 429/5xx/rede).
   * @param {(evento:object)=>void} [opcoes.onRequest] Callback de telemetria por requisicao.
   */
  constructor({
    token,
    baseUrl = 'https://ocpi.tupinrg.app',
    version = '2.2.1',
    countryCode = 'BR',
    partyId = '',
    timeoutMs = 30000,
    maxRetries = 3,
    onRequest = null,
  } = {}) {
    if (!token) throw new Error('Token da Tupi ausente.');
    if (!VERSOES.includes(version)) throw new Error(`Versao OCPI invalida: ${version}. Use ${VERSOES.join(' ou ')}.`);
    this.token = token;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.version = version;
    this.countryCode = countryCode;
    this.partyId = partyId;
    this.timeoutMs = timeoutMs;
    this.maxRetries = maxRetries;
    this.onRequest = onRequest;
  }

  /** GET cru com retry/backoff e validacao do envelope OCPI. */
  async get(url) {
    let ultimoErro;
    for (let tentativa = 0; tentativa <= this.maxRetries; tentativa++) {
      if (tentativa) await dormir(2 ** tentativa * 500);
      const t0 = Date.now();
      let res;
      try {
        res = await fetch(url, {
          headers: { Authorization: `Token ${this.token}`, Accept: 'application/json' },
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (e) {
        ultimoErro = new TupiApiError(`Falha de rede: ${e.message}`, { url });
        continue; // rede: vale repetir
      }

      const texto = await res.text();
      let json = null;
      try { json = JSON.parse(texto); } catch { /* resposta nao-JSON */ }

      this.onRequest?.({ url, http: res.status, ms: Date.now() - t0, ocpiStatus: json?.status_code });

      if (!res.ok) {
        const erro = new TupiApiError(
          `HTTP ${res.status} em ${url}${json?.status_message ? ` — ${json.status_message}` : ''}`,
          { http: res.status, ocpiStatus: json?.status_code, ocpiMessage: json?.status_message, url, corpo: texto.slice(0, 500) },
        );
        if (HTTP_SEM_RETRY.has(res.status)) throw erro; // 401 = token invalido/sem permissao: repetir so queima cota
        ultimoErro = erro;
        continue;
      }
      if (!json) {
        throw new TupiApiError('Resposta nao e JSON.', { http: res.status, url, corpo: texto.slice(0, 500) });
      }
      if (json.status_code !== 1000) {
        throw new TupiApiError(
          `OCPI status_code ${json.status_code} — ${json.status_message ?? 'sem mensagem'}`,
          { http: res.status, ocpiStatus: json.status_code, ocpiMessage: json.status_message, url },
        );
      }

      return {
        data: json.data,
        envelope: { status_code: json.status_code, status_message: json.status_message, timestamp: json.timestamp },
        paginacao: {
          proxima: proximaPagina(res.headers.get('link')),
          total: res.headers.get('x-total-count') ? Number(res.headers.get('x-total-count')) : null,
          limite: res.headers.get('x-limit') ? Number(res.headers.get('x-limit')) : null,
        },
        http: res.status,
      };
    }
    throw ultimoErro ?? new TupiApiError('Falha desconhecida.', { url });
  }

  montarUrl(caminho, { limit, offset, dateFrom, dateTo } = {}) {
    const url = new URL(this.baseUrl + caminho);
    if (limit != null) url.searchParams.set('limit', String(limit));
    if (offset != null) url.searchParams.set('offset', String(offset));
    if (dateFrom) url.searchParams.set('date_from', dateFrom);
    if (dateTo) url.searchParams.set('date_to', dateTo);
    return url.toString();
  }

  /** Uma pagina de locations. */
  locations(params = {}) {
    return this.get(this.montarUrl(`/${this.version}/locations`, { limit: 50, offset: 0, ...params }));
  }

  /** Uma pagina de sessions. */
  sessions(params = {}) {
    return this.get(this.montarUrl(`/${this.version}/sessions`, { limit: 50, offset: 0, ...params }));
  }

  /**
   * Percorre todas as paginas de um recurso, seguindo Link rel="next" e caindo
   * para offset quando o servidor nao manda o header.
   * @param {'locations'|'sessions'} recurso
   */
  async *paginar(recurso, { limit = 50, maxPaginas = Infinity, ...params } = {}) {
    let url = this.montarUrl(`/${this.version}/${recurso}`, { limit, offset: 0, ...params });
    let offset = 0;
    for (let pagina = 1; pagina <= maxPaginas; pagina++) {
      const r = await this.get(url);
      const itens = Array.isArray(r.data) ? r.data : [];
      yield { pagina, itens, paginacao: r.paginacao, envelope: r.envelope };
      if (!itens.length) return;
      if (r.paginacao.proxima) {
        url = r.paginacao.proxima;
      } else {
        if (itens.length < limit) return;              // pagina incompleta = fim
        offset += limit;
        if (r.paginacao.total != null && offset >= r.paginacao.total) return;
        url = this.montarUrl(`/${this.version}/${recurso}`, { limit, offset, ...params });
      }
    }
  }

  /** Todos os itens de um recurso, ja concatenados. */
  async coletarTudo(recurso, opcoes = {}) {
    const itens = [];
    let total = null;
    for await (const p of this.paginar(recurso, opcoes)) {
      itens.push(...p.itens);
      if (p.paginacao.total != null) total = p.paginacao.total;
    }
    return { itens, total };
  }

  /** Dados do titular de uma sessao (endpoint Tupi Extra, fora do padrao OCPI). */
  async userData(sessionId, { countryCode = this.countryCode, partyId = this.partyId } = {}) {
    if (!partyId) throw new Error('party_id obrigatorio para user-data (defina TUPI_PARTY_ID).');
    const url = `${this.baseUrl}/extra/v1/sessions/${countryCode}/${partyId}/${encodeURIComponent(sessionId)}/user-data`;
    const r = await this.get(url);
    return r.data;
  }
}

/** Mascara campos pessoais para log e saida de terminal. */
export function mascarar(valor) {
  if (typeof valor !== 'string' || !valor) return valor;
  if (valor.includes('@')) {
    const [u, d] = valor.split('@');
    return `${u.slice(0, 1)}***@${d}`;
  }
  return valor.length <= 4 ? '***' : `${valor.slice(0, 2)}***${valor.slice(-2)}`;
}

const CAMPOS_PESSOAIS = new Set(['name', 'document', 'email', 'phone', 'street_name', 'number', 'district', 'zip_code']);

/** Copia de user_data com os campos pessoais mascarados. */
export function mascararUserData(userData) {
  if (!userData || typeof userData !== 'object') return userData;
  return Object.fromEntries(
    Object.entries(userData).map(([k, v]) => [k, CAMPOS_PESSOAIS.has(k) ? mascarar(v) : v]),
  );
}

export function clienteDoAmbiente(env = process.env, extras = {}) {
  return new TupiOcpiClient({
    token: env.TUPI_OCPI_TOKEN,
    baseUrl: env.TUPI_OCPI_BASE || undefined,
    version: env.TUPI_OCPI_VERSION || '2.2.1',
    countryCode: env.TUPI_COUNTRY_CODE || 'BR',
    partyId: env.TUPI_PARTY_ID || '',
    ...extras,
  });
}
