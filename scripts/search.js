const https = require('https');
const fs = require('fs');
const path = require('path');

// ============ 配置区 ============
// 搜索关键词（英文API搜英文关键词效果最好）
const SEARCH_QUERIES = [
  'near-infrared spectroscopy agricultural products quality detection',
  'NIRS food quality assessment nondestructive',
  'near-infrared spectroscopy grain moisture protein',
  'NIR spectroscopy fruit vegetable freshness',
  'near infrared soil nutrient crop analysis',
  'hyperspectral imaging food safety agricultural'
];
const MAX_RESULTS = 6;  // 每个关键词每个源最多搜几篇
const MIN_YEAR = 2023;  // 只搜集2023年及以后的文献
const PAPERS_DIR = path.join(__dirname, '..', 'papers');
const DATA_DIR = path.join(__dirname, '..', 'data');
const COLLECTED_FILE = path.join(DATA_DIR, 'collected.json');

// ============ 基础工具 ============
function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: { 'User-Agent': 'NIR-Papers-Bot/1.0 (mailto:test@example.com)' },
      timeout: 20000
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); } catch { reject(new Error('JSON解析错误')); }
      });
    }).on('error', reject);
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function stripHtml(html) {
  if (!html) return '';
  return html.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').trim();
}

// ============ 数据源1：Semantic Scholar ============
async function searchSemanticScholar(query) {
  try {
    const url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(query)}&limit=${MAX_RESULTS}&year=${MIN_YEAR}-&fields=title,authors,year,abstract,url,externalIds,publicationDate,citationCount,venue`;
    const res = await fetchUrl(url);
    return (res.data || []).map(p => ({
      id: p.paperId, title: p.title || '无标题',
      authors: (p.authors || []).slice(0, 4).map(a => a.name).join(', '),
      year: p.year || '', date: p.publicationDate || '',
      abstract: p.abstract || '',
      url: p.url || (p.externalIds?.DOI ? `https://doi.org/${p.externalIds.DOI}` : ''),
      doi: p.externalIds?.DOI || '', citations: p.citationCount || 0,
      venue: p.venue || '', source: 'Semantic Scholar'
    }));
  } catch (e) { console.error(`  Semantic Scholar 出错: ${e.message}`); return []; }
}

// ============ 数据源2：CrossRef ============
async function searchCrossRef(query) {
  try {
    const url = `https://api.crossref.org/works?query=${encodeURIComponent(query)}&rows=${MAX_RESULTS}&filter=from-pub-date:${MIN_YEAR}-01-01&sort=published&order=desc`;
    const res = await fetchUrl(url);
    return (res.message?.items || []).map(item => ({
      id: item.DOI || '', title: item.title?.[0] || '无标题',
      authors: (item.author || []).slice(0, 4).map(a => `${a.given || ''} ${a.family || ''}`.trim()).join(', '),
      year: item.published?.['date-parts']?.[0]?.[0] || '',
      date: item.published?.['date-parts']?.[0]?.join('-') || '',
      abstract: stripHtml(item.abstract || ''),
      url: item.URL || (item.DOI ? `https://doi.org/${item.DOI}` : ''),
      doi: item.DOI || '', citations: item['is-referenced-by-count'] || 0,
      venue: item['container-title']?.[0] || '', source: 'CrossRef'
    }));
  } catch (e) { console.error(`  CrossRef 出错: ${e.message}`); return []; }
}

// ============ 去重与历史记录 ============
function loadCollected() {
  try { return JSON.parse(fs.readFileSync(COLLECTED_FILE, 'utf-8')); } catch { return []; }
}
function deduplicate(papers) {
  const seen = new Set();
  return papers.filter(p => {
    const key = p.doi ? `doi:${p.doi}` : `t:${p.title.toLowerCase().replace(/\s+/g, '')}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}

// ============ 生成 Markdown ============
function generateMarkdown(papers, date) {
  let md = `# 近红外光谱·农产品检测 每日文献速递 (${date})\n\n`;
  md += `> 自动搜集 | 共 ${papers.length} 篇新文献\n\n---\n\n## 快速目录\n\n`;
  papers.forEach((p, i) => { md += `${i + 1}. **${p.title}** (${p.year}) [${p.source}]\n`; });
  md += `\n---\n\n`;
  papers.forEach((p, i) => {
    md += `## ${i + 1}. ${p.title}\n\n`;
    md += `- **作者**: ${p.authors || '未知'}\n- **日期**: ${p.date || p.year}\n- **期刊**: ${p.venue || '未知'}\n- **链接**: ${p.url}\n`;
    if (p.doi) md += `- **DOI**: ${p.doi}\n`;
    md += `- **引用数**: ${p.citations}\n- **来源**: ${p.source}\n\n`;
    md += p.abstract ? `### 摘要\n${p.abstract}\n\n` : `### 摘要\n暂无，请点击链接查看原文\n\n`;
    md += `---\n\n`;
  });
  return md;
}

// ============ 上传到 Coze 知识库 ============
function uploadToCoze(filePath) {
  return new Promise((resolve) => {
    const token = process.env.COZE_API_TOKEN;
    const datasetId = process.env.COZE_DATASET_ID;
    if (!token || !datasetId) {
      console.log('⚠️ 未检测到 Coze 密钥，跳过上传到知识库（仅保存到仓库）。');
      resolve(false); return;
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    const base64Content = Buffer.from(content).toString('base64');
    const fileName = path.basename(filePath);
    const postData = JSON.stringify({
      dataset_id: datasetId,
      documents: [{ name: fileName, source_info: { file_base64: base64Content, file_type: 'markdown' } }]
    });

    const req = https.request({
      hostname: 'api.coze.cn', path: '/v1/datasets/create_file', method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    }, (res) => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { console.log('Coze 上传结果:', d.slice(0, 200)); resolve(true); });
    });
    req.on('error', (e) => { console.error('Coze 上传网络错误:', e.message); resolve(false); });
    req.write(postData); req.end();
  });
}

// ============ 主程序 ============
async function main() {
  const today = new Date().toISOString().split('T')[0];
  console.log(`\n=== 开始搜集文献: ${today} ===\n`);
  fs.mkdirSync(PAPERS_DIR, { recursive: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });

  let allPapers = [];
  for (const q of SEARCH_QUERIES) {
    console.log(`搜索: ${q}`);
    const ss = await searchSemanticScholar(q);
    console.log(`  Semantic Scholar 找到 ${ss.length} 篇`);
    allPapers.push(...ss);
    await sleep(1500); // 防止请求太快被封

    const cr = await searchCrossRef(q);
    console.log(`  CrossRef 找到 ${cr.length} 篇`);
    allPapers.push(...cr);
    await sleep(1000);
  }

  // 去除本次搜索内的重复
  allPapers = deduplicate(allPapers);
  console.log(`\n合并去重后共: ${allPapers.length} 篇`);

  // 去除历史已搜集的
  const collected = loadCollected();
  const collectedKeys = new Set(collected.map(c => c.doi ? `doi:${c.doi}` : `t:${c.title.toLowerCase().replace(/\s+/g, '')}`));
  const newPapers = allPapers.filter(p => {
    const key = p.doi ? `doi:${p.doi}` : `t:${p.title.toLowerCase().replace(/\s+/g, '')}`;
    return !collectedKeys.has(key);
  });
  newPapers.sort((a, b) => b.citations - a.citations);
  console.log(`新增文献: ${newPapers.length} 篇 (排除历史 ${collected.length} 篇)`);

  if (newPapers.length > 0) {
    const md = generateMarkdown(newPapers, today);
    const filePath = path.join(PAPERS_DIR, `${today}.md`);
    fs.writeFileSync(filePath, md, 'utf-8');
    console.log(`已生成报告: ${filePath}`);

    collected.push(...newPapers.map(p => ({ doi: p.doi, title: p.title, date: today })));
    fs.writeFileSync(COLLECTED_FILE, JSON.stringify(collected, null, 2), 'utf-8');
    
    await uploadToCoze(filePath);
  } else {
    console.log('今日没有发现新文献。');
  }
  console.log(`\n=== 任务完成 ===\n`);
}

main().catch(e => { console.error('致命错误:', e); process.exit(1); });
