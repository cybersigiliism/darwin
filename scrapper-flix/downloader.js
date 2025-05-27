// downloader.js
import { firefox } from 'playwright';
import fs from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';
import { URL } from 'url';

const COMMON_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:100.0) Gecko/20100101 Firefox/100.0';

let DEBUG_MODE = false;
let TARGET_PAGE_URL_ARG = '';
let OUTPUT_BASE_DIR_ARG = ''; // Agora é o diretório base

function logDebug(...args) { if (DEBUG_MODE) console.log('[DEBUG]', ...args); }
function logInfo(...args) { if (DEBUG_MODE) console.info('[INFO]', ...args); }
function logError(...args) { console.error('[ERROR]', ...args); }
function logWarn(...args) { if (DEBUG_MODE) console.warn('[WARN]', ...args); }

function extractUrlInfo(pageUrl) {
    try {
        const urlObj = new URL(pageUrl);
        const pathParts = urlObj.pathname.split('/').filter(p => p); // Remove partes vazias

        // Ex: /player/e/80727/24-ester-ana/288715.html
        // pathParts = ["player", "e", "80727", "24-ester-ana", "288715.html"]
        if (pathParts.length >= 5) {
            const girlId = pathParts[2];
            const videoIdAndGirlNamePart = pathParts[3]; // "24-ester-ana"
            
            const match = videoIdAndGirlNamePart.match(/^(\d+)-(.*)$/);
            if (match) {
                const videoId = match[1]; // "24"
                const girlName = match[2]; // "ester-ana"
                const girlIdAndName = `${girlName}`;
                return { videoId, girlIdAndName, girlName };
            }
        }
    } catch (e) {
        logError("Erro ao extrair informações da URL:", e.message);
    }
    return null;
}


async function findM3u8Details(pageUrl, iframeSel, videoSelInFrame) {
  logInfo('Iniciando Playwright para encontrar URL do M3U8...');
  const browser = await firefox.launch({ headless: !DEBUG_MODE });
  const context = await browser.newContext({ userAgent: COMMON_USER_AGENT });

  const cookiesToSet = [ /* Seus cookies aqui, mantenha-os atualizados */
    { name: "REMEMBERME", value: "VXNlckJ1bmRsZVxFbnRpdHlcVXNlcjphMjl5YVc1aGJXVjZRR2R0WVdsc0xtTnZiUT09OjE3NzkzMjI5OTY6MzM5Y2ZjNDYxY2U0Mjg1OGMxMTk4NTNiZDdhNTBlNGY5MzJlMzRkMmZlZDg5ZTUxY2NiN2UxZjczZTljNzg2NQ%3D%3D", domain: ".onlyflix.me", path: "/", secure: true, httpOnly: true, sameSite: "Lax" },
    { name: "PHPSESSID", value: "7rjdjavuds40a7o1vqksm4jue3", domain: ".onlyflix.me", path: "/", secure: true, httpOnly: true, sameSite: "Lax" }
  ];

  if (cookiesToSet.length > 0) {
    logDebug('Adicionando cookies...');
    await context.addCookies(cookiesToSet.map(c => ({...c, secure: pageUrl.startsWith('https://')})));
  }

  const page = await context.newPage();
  let m3u8Url = null;
  let networkM3u8Url = null;
  let videoResolution = "unknown";

  const m3u8Promise = new Promise((resolve) => {
    page.on('request', request => {
      const url = request.url();
      if (url.includes('.m3u8')) {
        const isSpecific = url.includes('video.m3u8') || url.includes('chunklist') || !url.includes('playlist.m3u8');
        if (isSpecific && (!networkM3u8Url || !networkM3u8Url.includes('video.m3u8'))) {
            logDebug(`M3U8 (prioritário) detectado: ${url}`);
            networkM3u8Url = url;
            resolve(url);
        } else if (!networkM3u8Url) {
            logDebug(`M3U8 (genérico) detectado: ${url}`);
            networkM3u8Url = url;
        }
        const resMatch = url.match(/\/(\d+p)\//i);
        if (resMatch && resMatch[1]) {
            videoResolution = resMatch[1];
            logDebug(`Resolução da URL M3U8: ${videoResolution}`);
        }
      }
    });
  });

  try {
    logInfo(`Navegando para: ${pageUrl}`);
    await page.goto(pageUrl, { waitUntil: 'load', timeout: 60000 });
    let contentContext = page;
    let currentFrameUrl = pageUrl;

    if (iframeSel && iframeSel.trim() !== '') {
      logDebug(`Procurando iframe: ${iframeSel}`);
      const frameLocator = page.locator(iframeSel);
      await frameLocator.waitFor({ state: 'attached', timeout: 30000 });
      const frame = await frameLocator.contentFrame();
      if (!frame) throw new Error('Frame do iframe não encontrado.');
      contentContext = frame;
      currentFrameUrl = frame.url();
      logInfo(`Contexto no iframe: ${currentFrameUrl}`);
    }
    
    if (videoSelInFrame) {
        logDebug(`Procurando vídeo: "${videoSelInFrame}"`);
        const videoElement = contentContext.locator(videoSelInFrame);
        await videoElement.waitFor({ state: 'attached', timeout: 30000 });
        const sourceElement = videoElement.locator('source[src*=".m3u8"]');
        if (await sourceElement.count() > 0) {
            const sourceSrc = await sourceElement.first().getAttribute('src');
            if(sourceSrc) {
                logDebug(`M3U8 da tag source: ${sourceSrc}`);
                m3u8Url = new URL(sourceSrc, currentFrameUrl).toString();
            }
        }
    }

    if (!m3u8Url) {
        logDebug("M3U8 não na source, aguardando rede...");
        m3u8Url = await Promise.race([m3u8Promise, new Promise(resolve => setTimeout(() => resolve(networkM3u8Url), 15000))]);
    }
    if(m3u8Url) logInfo(`URL M3U8 final: ${m3u8Url}`);

  } catch (error) {
    logError('Erro na navegação/localização:', error.message);
    m3u8Url = null;
  } finally {
    await browser.close();
    logInfo('Navegador Playwright fechado.');
  }

  if (!m3u8Url && networkM3u8Url) m3u8Url = networkM3u8Url;
  if (!m3u8Url) { logError('URL M3U8 não encontrada.'); return null; }
  return { m3u8Url, videoResolution, referer: TARGET_PAGE_URL_ARG };
}

async function downloadM3u8Content(url, referer) {
  logInfo(`Baixando M3U8: ${url}`);
  const headers = { 'Referer': referer, 'User-Agent': COMMON_USER_AGENT };
  const response = await fetch(url, { headers });
  if (!response.ok) {
    const errorText = await response.text().catch(() => "N/A");
    throw new Error(`Falha M3U8 (${response.status}) de ${url}. Resposta: ${errorText.slice(0,200)}`);
  }
  return response.text();
}

function parseM3u8(m3u8Content, baseUrl) {
  const lines = m3u8Content.split('\n');
  const segmentUrls = [];
  const m3u8BaseUrl = new URL(baseUrl);
  let isVariantLine = false;
  const variantPlaylists = [];
  let currentResolution = "unknown";

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#EXT-X-STREAM-INF')) {
      isVariantLine = true;
      const resMatch = trimmed.match(/RESOLUTION=(\d+x\d+)/i);
      currentResolution = (resMatch && resMatch[1]) ? resMatch[1] : "unknown";
      logDebug(`Resolução M3U8 EXT-X-STREAM-INF: ${currentResolution}`);
    } else if (isVariantLine && trimmed && !trimmed.startsWith('#')) {
      try {
        variantPlaylists.push({url: new URL(trimmed, m3u8BaseUrl.href).toString(), resolution: currentResolution});
      } catch (e) { logWarn(`URL variante inválida: ${trimmed}`); }
      isVariantLine = false;
    } else if (trimmed && !trimmed.startsWith('#') && (trimmed.includes('.ts') || trimmed.match(/segment-\d+/i)) ) {
      try { segmentUrls.push(new URL(trimmed, m3u8BaseUrl.href).toString()); }
      catch (e) { logWarn(`URL segmento inválida: ${trimmed}`); }
    }
  }

  if (segmentUrls.length > 0) return { type: 'segments', data: segmentUrls, resolution: "unknown" };
  if (variantPlaylists.length > 0) {
    const best = variantPlaylists.sort((a,b) => { // Tenta pegar a maior resolução
        const resA = parseInt(a.resolution.split('x')[1] || 0);
        const resB = parseInt(b.resolution.split('x')[1] || 0);
        return resB - resA;
    })[0] || variantPlaylists[0];
    logInfo(`Usando variante: ${best.url} (Res: ${best.resolution})`);
    return { type: 'variant', data: [best.url], resolution: best.resolution };
  }
  return { type: 'none', data: [] };
}

async function downloadTsSegment(url, filePath, index, total, referer) {
  const safeBaseName = path.basename(filePath).substring(0, 100);
  if (DEBUG_MODE) process.stdout.write(`DL seg ${index + 1}/${total}: ${safeBaseName}... `);
  else if ((index + 1) % 25 === 0 || index === 0 || index === total -1) {
      process.stdout.write(`Progresso: ${index + 1}/${total} segmentos... \r`);
  }
  try {
    const headers = { 'Referer': referer, 'User-Agent': COMMON_USER_AGENT };
    const response = await fetch(url, { headers });
    if (!response.ok) throw new Error(`Falha DL ${url} (${response.status})`);
    await fs.writeFile(path.join(path.dirname(filePath), safeBaseName), Buffer.from(await response.arrayBuffer()));
    if (DEBUG_MODE) process.stdout.write('OK\n');
  } catch (error) {
    if (DEBUG_MODE) process.stdout.write('FALHOU\n');
    logError(`Erro DL ${url}:`, error.message);
    throw error;
  }
}

async function concatenateTsFiles(tsFilePaths, outputMp4Path) {
  logInfo(`Concatenando ${tsFilePaths.length} segs para ${outputMp4Path}`);
  const tempDir = path.dirname(tsFilePaths[0]);
  const fileListPath = path.join(tempDir, 'filelist.txt');
  await fs.writeFile(fileListPath, tsFilePaths.map(p => `file '${path.resolve(p).replace(/'/g, "'\\''")}'`).join('\n'));
  return new Promise((resolve, reject) => {
    const args = ['-protocol_whitelist', 'file,http,https,tcp,tls,crypto', '-f', 'concat', '-safe', '0', '-i', fileListPath, '-c', 'copy', '-bsf:a', 'aac_adtstoasc', '-y', outputMp4Path];
    logDebug(`FFmpeg: ffmpeg ${args.join(' ')}`);
    const proc = spawn('ffmpeg', args, { stdio: DEBUG_MODE ? 'pipe' : ['ignore', 'ignore', 'pipe'] });
    let output = '';
    if (proc.stdout && DEBUG_MODE) proc.stdout.on('data', (d) => { output += d; process.stdout.write(d); });
    if (proc.stderr) proc.stderr.on('data', (d) => { output += d; if (DEBUG_MODE) process.stderr.write(d); });
    proc.on('exit', (code) => code === 0 ? (logInfo('FFmpeg OK.'), resolve()) : (logError(`FFmpeg falhou ${code}. Output: ${output.slice(-500)}`), reject(new Error(`FFmpeg ${code}`))));
    proc.on('error', (err) => { logError('FFmpeg iniciar falhou:', err); reject(err); });
  });
}

async function cleanupTempFiles(tsFilePaths) {
    if (tsFilePaths.length === 0) return;
    const tempDir = path.dirname(tsFilePaths[0]);
    logInfo('Limpando temps...');
    try {
        await fs.unlink(path.join(tempDir, 'filelist.txt')).catch(()=>{});
        await Promise.all(tsFilePaths.map(fp => fs.unlink(fp).catch(()=>{}) ));
        await fs.rmdir(tempDir).catch(e => { if(DEBUG_MODE) logWarn(`Remover ${tempDir} falhou: ${e.message}`);});
    } catch (error) { logError('Erro na limpeza:', error.message); }
}

async function main() {
    const args = process.argv.slice(2);
    DEBUG_MODE = args.includes('--debug');
    
    if (args.length < 2 || (args.length > 2 && !DEBUG_MODE) || (args.length > 3 && DEBUG_MODE)) {
        console.log("Uso: bun run downloader.js <url_da_pagina> <pasta_de_saida_base> [--debug]");
        process.exit(1);
    }

    TARGET_PAGE_URL_ARG = args[0];
    OUTPUT_BASE_DIR_ARG = path.resolve(args[1]);

    const urlInfo = extractUrlInfo(TARGET_PAGE_URL_ARG);
    if (!urlInfo) {
        logError("Não foi possível extrair informações da URL para nomear o arquivo/pasta.");
        process.exitCode = 1;
        return;
    }
    const { videoId, girlIdAndName } = urlInfo;
    const targetDir = path.join(OUTPUT_BASE_DIR_ARG, girlIdAndName);
    
    let downloadedTsFilePaths = [];
    // O diretório temporário agora é baseado no ID do vídeo para evitar conflitos se o mesmo vídeo for tentado em paralelo
    const tempTsDir = path.join(targetDir, `temp_${videoId}_${Date.now()}`);


    try {
        await fs.mkdir(targetDir, { recursive: true }); // Cria a pasta da "menina"
        logInfo(`Pasta de destino: ${targetDir}`);

        const m3u8Details = await findM3u8Details(TARGET_PAGE_URL_ARG, '.flix_app_player > iframe:nth-child(1)', '#main-video');
        if (!m3u8Details || !m3u8Details.m3u8Url) { process.exitCode = 1; return; }

        let { m3u8Url, videoResolution, referer } = m3u8Details;
        let m3u8Content = await downloadM3u8Content(m3u8Url, referer);
        let parsedM3u8 = parseM3u8(m3u8Content, m3u8Url);

        if (parsedM3u8.resolution && parsedM3u8.resolution !== "unknown") videoResolution = parsedM3u8.resolution;

        if (parsedM3u8.type === 'variant') {
            const variantUrl = parsedM3u8.data[0];
            logInfo(`Processando variante: ${variantUrl}`);
            m3u8Content = await downloadM3u8Content(variantUrl, referer);
            const variantParsed = parseM3u8(m3u8Content, variantUrl);
            if (variantParsed.resolution && variantParsed.resolution !== "unknown") videoResolution = variantParsed.resolution;
            else if (variantUrl.match(/\/(\d+p)\//i)) videoResolution = variantUrl.match(/\/(\d+p)\//i)[1];
            parsedM3u8.data = variantParsed.data; // Usa os segmentos da variante
        }
        
        const tsUrls = parsedM3u8.data.filter(u => typeof u === 'string' && u.includes('.ts')); // Garante que são URLs de TS

        if (tsUrls.length === 0) { logError("Nenhum segmento .ts encontrado."); process.exitCode = 1; return; }
        
        // Define nome do arquivo e verifica se já existe
        const cleanRes = videoResolution.includes('x') ? videoResolution.split('x')[1] + 'p' : (videoResolution === "unknown" ? "" : videoResolution);
        const outputFileName = cleanRes ? `${videoId}-${cleanRes}.mp4` : `${videoId}.mp4`;
        const outputFilePath = path.join(targetDir, outputFileName);

        try {
            await fs.access(outputFilePath); // Verifica se o arquivo existe
            logInfo(`Vídeo já existe: ${outputFilePath}. Pulando.`);
            if (!DEBUG_MODE) console.log(outputFilePath); // Informa o caminho mesmo pulando
            process.exitCode = 0; // Sucesso, pois o arquivo já está lá
            return;
        } catch (e) {
            // Arquivo não existe, continuar com o download
            logInfo(`Arquivo de vídeo não encontrado, iniciando download: ${outputFileName}`);
        }

        await fs.mkdir(tempTsDir, { recursive: true });
        logInfo(`Temps em: ${tempTsDir}`);

        for (let i = 0; i < tsUrls.length; i++) {
          const tsUrl = tsUrls[i];
          let segName = `seg_${String(i).padStart(5, '0')}.ts`;
          try {
            const bn = path.basename(new URL(tsUrl).pathname);
            if (bn && bn.toLowerCase().includes('.ts')) segName = `${String(i).padStart(5,'0')}_${bn.split('?')[0]}`;
          } catch (e) {}
          await downloadTsSegment(tsUrl, path.join(tempTsDir, segName), i, tsUrls.length, referer);
          downloadedTsFilePaths.push(path.join(tempTsDir, segName));
        }
        if(!DEBUG_MODE && tsUrls.length > 0) process.stdout.write('\n');

        try { await fs.unlink(outputFilePath); } catch(e) {}
        await concatenateTsFiles(downloadedTsFilePaths, outputFilePath);

        if (!DEBUG_MODE) console.log(outputFilePath);
        else logInfo(`Vídeo salvo: ${outputFilePath}`);
        process.exitCode = 0;

    } catch (error) {
        logError('Erro principal:', error.message);
        if (error.cause && DEBUG_MODE) logError("Causa:", error.cause);
        process.exitCode = 1;
    } finally {
        await cleanupTempFiles(downloadedTsFilePaths);
    }
}

main();