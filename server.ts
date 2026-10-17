import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import { fileURLToPath } from 'url';
import * as cheerio from 'cheerio';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

  app.use(express.json({ limit: '10mb' }));

  // Health check endpoint
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // CDR scraping endpoint
  app.post('/api/pabx/consultar', async (req, res) => {
    const {
      loginUrl = 'https://pabx.evence.com.br/login',
      cdrUrl = 'https://pabx.evence.com.br/cdr/pesquisar',
      email = 'suporte@interativanet.com.br',
      senha = 'smk03657',
      dataInicio, // YYYY-MM-DD
      dataFim,    // YYYY-MM-DD
      tipoChamada = 'IN',
      maxPaginas = 20
    } = req.body;

    if (!dataInicio || !dataFim) {
      return res.status(400).json({ error: 'dataInicio e dataFim são obrigatórios (formato YYYY-MM-DD)' });
    }

    try {
      // 1. Format dates from YYYY-MM-DD to DD-MM-YYYY
      const [anoI, mesI, diaI] = dataInicio.split('-');
      const [anoF, mesF, diaF] = dataFim.split('-');
      const dataInicioStr = `${diaI}-${mesI}-${anoI}`;
      const dataFimStr = `${diaF}-${mesF}-${anoF}`;

      // Cookie jar simulation
      let cookies: string[] = [];
      const getCookieHeader = () => cookies.join('; ');

      const parseSetCookie = (setCookieHeaders: string | string[] | undefined) => {
        if (!setCookieHeaders) return;
        const headersArray = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
        for (const header of headersArray) {
          const cookiePair = header.split(';')[0];
          if (cookiePair) {
            const [name] = cookiePair.split('=');
            cookies = cookies.filter(c => !c.startsWith(`${name}=`));
            cookies.push(cookiePair);
          }
        }
      };

      // 2. Fetch login page to extract CSRF token
      console.log(`[PABX] Fetching login page: ${loginUrl}`);
      const loginPageRes = await fetch(loginUrl, {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
        signal: AbortSignal.timeout(15000),
      });

      parseSetCookie(loginPageRes.headers.getSetCookie?.() || loginPageRes.headers.get('set-cookie') || undefined);
      const loginHtml = await loginPageRes.text();
      const $login = cheerio.load(loginHtml);
      const csrfToken = $login('input[name="_token"]').val() || '';

      console.log(`[PABX] CSRF token obtained: ${csrfToken ? 'Yes' : 'No'}`);

      // 3. Login POST
      const loginBody = new URLSearchParams();
      loginBody.append('login', email);
      loginBody.append('senha', senha);
      loginBody.append('_token', csrfToken.toString());

      const authRes = await fetch(loginUrl, {
        method: 'POST',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
          'Content-Type': 'application/x-www-form-urlencoded',
          'Cookie': getCookieHeader(),
          'Referer': loginUrl,
        },
        body: loginBody.toString(),
        redirect: 'manual',
        signal: AbortSignal.timeout(15000),
      });

      parseSetCookie(authRes.headers.getSetCookie?.() || authRes.headers.get('set-cookie') || undefined);

      const location = authRes.headers.get('location');
      console.log(`[PABX] Auth status: ${authRes.status}, location: ${location}`);

      // 4. Fetch CDR pages
      const dados: Array<{
        dataHora: string;
        data: string;
        hora: string;
        horaInt: number;
        origem: string;
        destino: string;
        fila: string;
        duracao: string;
        segundos: number;
        status: string;
        tipo: string;
      }> = [];

      let pagina = 1;
      let totalPaginasProcessadas = 0;

      while (pagina <= maxPaginas) {
        totalPaginasProcessadas++;
        const params = new URLSearchParams({
          ramal_origem: '',
          numero_origem: '',
          ramal_destino: '',
          numero_destino: '',
          did: '',
          status_chamada: '',
          centrocusto_id: '',
          tipo_chamada: tipoChamada,
          gravacao: '',
          discador: '0',
          data_inicial: dataInicioStr,
          data_final: dataFimStr,
          page: pagina.toString(),
        });

        const targetUrl = `${cdrUrl}?${params.toString()}`;
        console.log(`[PABX] Buscando página ${pagina}: ${targetUrl}`);

        let resCDR: Response | null = null;
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            resCDR = await fetch(targetUrl, {
              headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
                'Cookie': getCookieHeader(),
                'Referer': 'https://pabx.evence.com.br/cdr',
              },
              signal: AbortSignal.timeout(20000),
            });
            break;
          } catch (err) {
            console.warn(`[PABX] Falha na tentativa ${attempt} para página ${pagina}:`, err);
            if (attempt === 3) throw err;
            await new Promise(r => setTimeout(r, 1500));
          }
        }

        if (!resCDR) break;

        const cdrHtml = await resCDR.text();
        const $cdr = cheerio.load(cdrHtml);
        const rows = $cdr('table tbody tr');

        if (rows.length === 0) {
          console.log(`[PABX] Nenhuma linha encontrada na página ${pagina}. Fim da paginação.`);
          break;
        }

        let encontrouRegistrosNaPagina = false;

        rows.each((_, row) => {
          const cols = $cdr(row).find('td');
          if (cols.length >= 7) {
            encontrouRegistrosNaPagina = true;
            const dataHora = $cdr(cols[0]).text().trim();
            const origem = cols.length >= 8 ? $cdr(cols[1]).text().trim() : '';
            const destino = cols.length >= 8 ? $cdr(cols[2]).text().trim() : '';
            const fila = cols.length >= 8 ? $cdr(cols[4]).text().trim() : $cdr(cols[3]).text().trim();
            const duracao = cols.length >= 8 ? $cdr(cols[5]).text().trim() : $cdr(cols[4]).text().trim();
            const status = cols.length >= 8 ? $cdr(cols[6]).text().trim() : $cdr(cols[5]).text().trim();
            const tipo = cols.length >= 8 ? $cdr(cols[7]).text().trim() : $cdr(cols[6]).text().trim();

            // Format check: "DD-MM-YYYY HH:mm:ss"
            const parts = dataHora.split(' ');
            if (parts.length === 2) {
              const [d, m, y] = parts[0].split('-');
              const isoData = `${y}-${m}-${d}`;
              const hora = parts[1];
              const horaInt = parseInt(hora.split(':')[0], 10) || 0;

              // Parse duration "HH:MM:SS"
              const durParts = duracao.split(':');
              let segundos = 0;
              if (durParts.length === 3) {
                segundos = parseInt(durParts[0], 10) * 3600 + parseInt(durParts[1], 10) * 60 + parseInt(durParts[2], 10);
              } else if (durParts.length === 2) {
                segundos = parseInt(durParts[0], 10) * 60 + parseInt(durParts[1], 10);
              }

              dados.push({
                dataHora,
                data: isoData,
                hora,
                horaInt,
                origem,
                destino,
                fila: fila || 'Geral',
                duracao,
                segundos: isNaN(segundos) ? 0 : segundos,
                status: status || 'Desconhecido',
                tipo: tipo || 'IN',
              });
            }
          }
        });

        if (!encontrouRegistrosNaPagina) break;
        pagina++;
        // Small rate limit delay
        await new Promise(r => setTimeout(r, 250));
      }

      return res.json({
        success: true,
        source: 'live',
        totalRegistros: dados.length,
        paginasConsultadas: totalPaginasProcessadas,
        dados,
      });

    } catch (error: any) {
      console.error('[PABX] Erro ao consultar PABX:', error);
      return res.status(502).json({
        success: false,
        source: 'failed',
        error: error.message || 'Falha ao conectar com o PABX Evence',
        detalhes: 'O servidor externo pode estar inacessível pela nuvem, exigir VPN ou as credenciais podem ter expirado.',
      });
    }
  });

  // Serve static files or Vite dev middleware
  if (process.env.NODE_ENV === 'production') {
    app.use(express.static('dist'));
    app.get('*', (req, res) => {
      res.sendFile(path.resolve('dist', 'index.html'));
    });
  } else {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[PABX Server] Pronto em http://0.0.0.0:${PORT}`);
  });
}

startServer();
