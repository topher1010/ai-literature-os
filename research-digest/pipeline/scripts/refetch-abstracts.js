#!/usr/bin/env node
/**
 * refetch-abstracts.js - One-off utility: re-fetch full abstracts from PubMed.
 *
 * Use this if the original poll captured truncated abstracts and you want to
 * re-fetch the full text (PubMed has been known to return only the first
 * paragraph for some papers via the summary endpoint).
 *
 * Reads/writes a JSON file with shape `{ papers: [{ pmid, abstract, ... }, ...] }`.
 * Path is configurable via DIGEST_PAPERS_JSON env var, default
 * `../data/papers.json` relative to this script.
 */

const fs = require('fs');
const https = require('https');
const path = require('path');

const PAPERS_PATH = process.env.DIGEST_PAPERS_JSON
  || path.join(__dirname, '../data/papers.json');

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
      res.on('error', reject);
    }).on('error', reject);
  });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function parseAbstracts(xml) {
  const result = {};
  const articleRegex = /<PubmedArticle>([\s\S]*?)<\/PubmedArticle>/g;
  let match;
  while ((match = articleRegex.exec(xml)) !== null) {
    const articleXml = match[1];

    const pmidMatch = articleXml.match(/<PMID[^>]*>(\d+)<\/PMID>/);
    if (!pmidMatch) continue;
    const pmid = pmidMatch[1];

    const abstractParts = [];
    const abstractSection = articleXml.match(/<Abstract>([\s\S]*?)<\/Abstract>/);
    if (abstractSection) {
      const abstractXml = abstractSection[1];
      const labeledRegex = /<AbstractText[^>]*Label="([^"]*)"[^>]*>([\s\S]*?)<\/AbstractText>/g;
      let lm;
      while ((lm = labeledRegex.exec(abstractXml)) !== null) {
        const label = lm[1];
        const text = lm[2].replace(/<[^>]+>/g, '').trim();
        if (text) abstractParts.push(`${label}: ${text}`);
      }
      if (abstractParts.length === 0) {
        const plainRegex = /<AbstractText[^>]*>([\s\S]*?)<\/AbstractText>/g;
        let pm;
        while ((pm = plainRegex.exec(abstractXml)) !== null) {
          const text = pm[1].replace(/<[^>]+>/g, '').trim();
          if (text) abstractParts.push(text);
        }
      }
    }
    if (abstractParts.length > 0) {
      result[pmid] = abstractParts.join(' ');
    }
  }
  return result;
}

async function main() {
  const raw = fs.readFileSync(PAPERS_PATH, 'utf8');
  const data = JSON.parse(raw);
  const papers = data.papers || [];

  const papersWithPmid = papers.filter(p => p.pmid);
  console.log(`Found ${papersWithPmid.length} papers with PMID out of ${papers.length} total`);

  const BATCH_SIZE = 50;
  let updated = 0;
  let notFound = 0;

  for (let i = 0; i < papersWithPmid.length; i += BATCH_SIZE) {
    const batch = papersWithPmid.slice(i, i + BATCH_SIZE);
    const pmids = batch.map(p => p.pmid).join(',');
    const url = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id=${pmids}&rettype=xml&retmode=xml`;

    console.log(`Fetching batch ${Math.floor(i/BATCH_SIZE)+1}: PMIDs ${i+1}-${Math.min(i+BATCH_SIZE, papersWithPmid.length)}`);
    try {
      const xml = await fetchUrl(url);
      const abstracts = parseAbstracts(xml);

      for (const paper of batch) {
        if (abstracts[paper.pmid]) {
          const oldLen = (paper.abstract || '').length;
          const newAbstract = abstracts[paper.pmid];
          const idx = papers.findIndex(p => p.pmid === paper.pmid);
          if (idx !== -1) {
            papers[idx].abstract = newAbstract;
            if (oldLen !== newAbstract.length) {
              updated++;
              if (oldLen < newAbstract.length) {
                console.log(`  PMID ${paper.pmid}: ${oldLen} -> ${newAbstract.length} chars`);
              }
            }
          }
        } else {
          notFound++;
          console.log(`  PMID ${paper.pmid}: no abstract in response`);
        }
      }
    } catch (err) {
      console.error(`  Batch error: ${err.message}`);
    }

    if (i + BATCH_SIZE < papersWithPmid.length) {
      await sleep(400);
    }
  }

  data.papers = papers;
  fs.writeFileSync(PAPERS_PATH, JSON.stringify(data, null, 2));
  console.log(`\nDone! Updated ${updated} abstracts, ${notFound} not found in PubMed response.`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
