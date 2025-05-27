import { parse } from 'node-html-parser';
import { writeFileSync, existsSync, mkdirSync } from 'fs';
import { bold, gray, green, yellow, red, cyan } from 'colorette';
import readline from 'readline/promises'; // Import for readline promises

const BASE_URL = 'https://play.onlyflix.me';
const LINKS_DIR = './links';

// Default values for concurrency and pages
const DEFAULT_MAX_PAGES = 11;
const DEFAULT_MODEL_THREADS = 5;
const DEFAULT_VIDEO_THREADS = 20;

const FETCH_MAX_RETRIES = 3;
const FETCH_RETRY_DELAY_MS = 1000;

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:138.0) Gecko/20100101 Firefox/138.0',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
  'DNT': '1',
  'Sec-GPC': '1',
  'Connection': 'keep-alive',
  'Cookie': 'REMEMBERME=VXNlckJ1bmRsZVxFbnRpdHlcVXNlcjphMjl5YVc1aGJXVjZRR2R0WVdsc0xtTnZiUT09OjE3NzkzMjI5OTY6MzM5Y2ZjNDYxY2U0Mjg1OGMxMTk4NTNiZDdhNTBlNGY5MzJlMzRkMmZlZDg5ZTUxY2NiN2UxZjczZTljNzg2NQ%3D%3D; PHPSESSID=7rjdjavuds40a7o1vqksm4jue3',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Priority': 'u=0, i',
  'TE': 'trailers'
};

function ensureLinksDirExists() {
  if (!existsSync(LINKS_DIR)) {
    mkdirSync(LINKS_DIR, { recursive: true });
    console.log(cyan(`Diretório ${bold(LINKS_DIR)} criado.`));
  }
}

function sanitizeFilename(name) {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

async function fetchWithRetry(url, options, maxRetries = FETCH_MAX_RETRIES, delay = FETCH_RETRY_DELAY_MS) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const response = await fetch(url, options);
      if (!response.ok) {
        throw new Error(`HTTP error ${response.status}`);
      }
      return response;
    } catch (error) {
      console.warn(yellow(`[Fetch Retry] Tentativa ${bold(i + 1)}/${maxRetries} falhou para ${gray(url)}: ${error.message}. Retentando em ${delay / 1000}s...`));
      if (i === maxRetries - 1) {
        console.error(red(`[Fetch Retry] Falha final ao buscar ${gray(url)} após ${bold(maxRetries)} tentativas.`));
        throw error;
      }
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw new Error(`[Fetch Retry] Excedido o número máximo de tentativas para ${url}`);
}

async function runConcurrentTasks(
  items,
  taskFn,
  maxConcurrency,
  taskGroupName
) {
  if (!items || items.length === 0) {
    console.log(yellow(`Nenhum item para processar em ${bold(taskGroupName)}.`));
    return;
  }

  const queue = [...items];
  const promises = [];
  const numWorkers = Math.min(maxConcurrency, queue.length);

  console.log(cyan(`Iniciando ${bold(numWorkers)} workers para ${bold(taskGroupName)} (${bold(items.length)} itens)...`));

  for (let i = 0; i < numWorkers; i++) {
    promises.push(
      (async (workerId) => {
        while (true) {
          const item = queue.pop();
          if (!item) break;
          try {
            await taskFn(item, workerId);
          } catch (error) {
            const itemName = (typeof item === 'object' && item !== null && item.name)
              ? item.name
              : (typeof item === 'string' && item.length > 60 ? item.substring(0, 57) + '...' : String(item));
            console.error(red(`[Worker ${workerId} para ${taskGroupName}] Erro ao processar ${bold(itemName)}: ${error.message}`));
          }
        }
      })(i)
    );
  }
  await Promise.all(promises);
  console.log(green(`Todos os ${bold(items.length)} itens para ${bold(taskGroupName)} processados.`));
}

async function processSingleVideoRedirect(videoRedirectUrl, modelName, headers) {
  try {
    const responseModelVideo = await fetchWithRetry(videoRedirectUrl, { headers });
    console.log(cyan(`  [${bold(modelName)}] URL real do vídeo: ${gray(responseModelVideo.url)} (de ${gray(videoRedirectUrl)})`));
    return responseModelVideo.url;
  } catch (error) {
    console.error(red(`  [${bold(modelName)}] Erro ao buscar URL final do vídeo para ${gray(videoRedirectUrl)}: ${error.message}`));
    return null;
  }
}

async function processModel(model, modelHeaders, videoFetchConcurrency) {
  console.log(cyan(`[${bold(model.name)}] Iniciando processamento... ${gray(model.link)}`));

  let responseModel;
  try {
    responseModel = await fetchWithRetry(model.link, { headers: modelHeaders });
  } catch (error) {
    console.error(red(`[${bold(model.name)}] Falha ao buscar página do modelo. Pulando.`));
    return;
  }

  const bodyModel = await responseModel.text();
  const rootModel = parse(bodyModel);
  const episodeElements = rootModel.querySelectorAll('div.serie-episodes > a.episode');

  if (!episodeElements || episodeElements.length === 0) {
    console.warn(yellow(`[${bold(model.name)}] Nenhum link de episódio encontrado.`));
  }

  const videoRedirectUrlList = episodeElements
    .map(element => element.attrs['href'] ? BASE_URL + element.attrs['href'] : null)
    .filter(url => url !== null);

  console.log(cyan(`[${bold(model.name)}] Encontrados ${bold(videoRedirectUrlList.length)} URLs de redirecionamento de vídeo.`));

  const videoUrlList = [];
  if (videoRedirectUrlList.length > 0) {
    await runConcurrentTasks(
      videoRedirectUrlList,
      async (redirectUrl) => {
        const finalUrl = await processSingleVideoRedirect(redirectUrl, model.name, modelHeaders);
        if (finalUrl) {
          videoUrlList.push(finalUrl);
        }
      },
      videoFetchConcurrency, // Use the passed concurrency for videos
      `Vídeos para ${model.name}`
    );
  }

  const filename = sanitizeFilename(model.name) + '.txt';
  const filePath = `${LINKS_DIR}/${filename}`;
  
  if (videoUrlList.length > 0) {
    writeFileSync(filePath, videoUrlList.join('\r\n'), { flag: 'w', encoding: 'utf8' });
    console.log(green(`[${bold(model.name)}] Salvo ${bold(videoUrlList.length)} URLs em ${bold(filePath)}`));
  } else {
    writeFileSync(filePath, 'Nenhum URL de vídeo foi buscado com sucesso.\r\n', { flag: 'w', encoding: 'utf8' });
    console.log(yellow(`[${bold(model.name)}] Nenhum vídeo encontrado ou buscado. Arquivo ${bold(filePath)} criado.`));
  }
  console.log(green(`[${bold(model.name)}] Processamento concluído.`));
}

async function getUserInput(rl, questionText, defaultValue) {
  const answer = await rl.question(`${questionText} (Padrão: ${defaultValue}): `);
  const parsed = parseInt(answer, 10);
  return answer.trim() === '' || isNaN(parsed) || parsed <= 0 ? defaultValue : parsed;
}

async function main() {
  ensureLinksDirExists();
  console.log(cyan(bold('🚀 Iniciando Scraper OnlyFlix 🚀')));

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const maxPages = await getUserInput(rl, 'Quantas páginas de modelos processar?', DEFAULT_MAX_PAGES);
  const modelConcurrency = await getUserInput(rl, 'Quantas threads para processar modelos?', DEFAULT_MODEL_THREADS);
  const videoConcurrency = await getUserInput(rl, 'Quantas threads para processar links de vídeo por modelo?', DEFAULT_VIDEO_THREADS);
  
  rl.close();

  console.log(cyan(bold(`\nConfigurações:`)));
  console.log(cyan(`  - Máximo de páginas: ${bold(maxPages)}`));
  console.log(cyan(`  - Threads para modelos: ${bold(modelConcurrency)}`));
  console.log(cyan(`  - Threads para vídeos por modelo: ${bold(videoConcurrency)}\n`));

  let totalModelsProcessed = 0;

  for (let currentPage = 1; currentPage <= maxPages; currentPage++) {
    console.log(green(bold(`--- Processando Página ${currentPage} de ${maxPages} ---`)));
    const pageUrl = `${BASE_URL}/series/all/newest.html?page=${currentPage}`;
    
    let initialResponse;
    try {
      console.log(cyan(`Buscando modelos da página ${bold(currentPage)}... ${gray(pageUrl)}`));
      initialResponse = await fetchWithRetry(pageUrl, { headers: HEADERS });
      console.log(green(`Status da busca da página ${bold(currentPage)}: ${bold(initialResponse.status)}`));
    } catch (error) {
      console.error(red(`Falha ao buscar modelos da página ${bold(currentPage)}. Pulando para a próxima página (se houver).`));
      continue; // Skip to the next page
    }

    const body = await initialResponse.text();
    const root = parse(body);
    const modelElements = root.querySelectorAll('div.content-section > .poster');

    if (!modelElements || modelElements.length === 0) {
      console.warn(yellow(`Nenhum modelo encontrado na página ${bold(currentPage)}. Pode ser o fim da lista ou um erro.`));
      if (currentPage > 1) { // Se não for a primeira página e não encontrar nada, provavelmente é o fim.
          console.log(yellow('Assumindo que esta é a última página com modelos.'));
          break; // Exit the loop if no models found on a subsequent page
      }
      continue;
    }

    const modelList = modelElements
      .map(element => {
        const href = element.attrs['href'];
        const title = element.attrs['title'];
        return href && title ? { link: BASE_URL + href, name: title } : null;
      })
      .filter(model => model !== null);

    console.log(cyan(`Encontrados ${bold(modelList.length)} modelos na página ${bold(currentPage)}.`));

    if (modelList.length === 0) {
      console.log(yellow(`Nenhum modelo válido para processar na página ${bold(currentPage)}.`));
      continue;
    }
    
    totalModelsProcessed += modelList.length;

    await runConcurrentTasks(
      modelList,
      (model) => processModel(model, HEADERS, videoConcurrency), // Pass videoConcurrency here
      modelConcurrency,
      `Modelos da Página ${currentPage}`
    );
     console.log(green(bold(`--- Página ${currentPage} Concluída ---`)));
  }

  console.log(green(bold(`\n✨ Scraping de ${totalModelsProcessed > 0 ? totalModelsProcessed : 'nenhum'} modelo(s) concluído em ${maxPages} página(s) (ou menos se não houver mais modelos)! ✨`)));
}

main().catch(err => {
  console.error(red(bold('❌ Erro global não tratado na execução:')), err);
  if (err.message && err.message.includes('readline')) {
    console.error(red('Pode ter ocorrido um problema com a interface de leitura. Tente executar novamente.'));
  }
  process.exit(1);
});