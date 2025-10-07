#!/usr/bin/env node
import fs from 'fs';
import { Parser } from 'n3';

const path = 'public/reasoning-rules/default-rules.n3';

function tryParseFull(text) {
  const parser = new Parser();
  return parser.parse(text);
}

function extractRuleBlocks(text) {
  // capture header (prefix lines)
  const headerMatch = text.match(/^(?:@prefix[^\n]*\n)+/m);
  const header = headerMatch ? headerMatch[0] : '';
  const ruleRe = /\{\s*([\s\S]*?)\s*\}\s*=>\s*\{\s*([\s\S]*?)\s*\}\s*\./g;
  const blocks = [];
  let m;
  while ((m = ruleRe.exec(text)) !== null) {
    blocks.push({ premise: m[1].trim(), conclusion: m[2].trim() });
  }
  return { header, blocks };
}

try {
  const text = fs.readFileSync(path, 'utf8');

  // Try parsing the whole document first
  try {
    const quads = tryParseFull(text);
    console.log('PARSE_OK_FULL', quads.length, 'quads');
    process.exit(0);
  } catch (fullErr) {
    console.warn('FULL_PARSE_FAILED - falling back to block parsing:', (fullErr && fullErr.message) || fullErr);
    // Fallback: extract rule blocks and parse each block individually
    const { header, blocks } = extractRuleBlocks(text);
    if (!blocks || blocks.length === 0) {
      console.error('NO_RULE_BLOCKS_FOUND - cannot recover from full parse failure');
      console.error(fullErr && (fullErr.stack || fullErr.message) || fullErr);
      process.exit(2);
    }
    const parser = new Parser();
    let total = 0;
    let parsedBlocks = 0;
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      try {
        const prem = parser.parse(header + b.premise);
        const concl = parser.parse(header + b.conclusion);
        console.log(`BLOCK_${i}_PARSE_OK premise:${prem.length} conclusion:${concl.length}`);
        total += prem.length + concl.length;
        parsedBlocks++;
      } catch (innerErr) {
        console.warn(`BLOCK_${i}_PARSE_FAILED`, (innerErr && innerErr.message) || innerErr);
      }
    }
    console.log('FALLBACK_PARSE_SUMMARY', { blocks: blocks.length, parsedBlocks, totalQuads: total });
    if (parsedBlocks === 0) {
      console.error('FALLBACK_PARSE_FAILED - no blocks parsed successfully');
      process.exit(2);
    }
    process.exit(0);
  }
} catch (e) {
  console.error('PARSE_ERROR', (e && (e.stack || e.message)) || String(e));
  process.exit(2);
}
