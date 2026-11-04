#!/usr/bin/env node
/*
 * © 2026 EPAM Systems, Inc. ("EPAM"). All rights reserved.
 * EPAM intellectual property, provided under a limited license — see LICENSE.
 * Ownership and all IP rights remain with EPAM and are NOT transferred by use,
 * incorporation, or cloning into any repository.
 */

/**
 * slop-scan.mjs — deterministic evidence collector for the humanizer skill.
 *
 * Two layers, reported separately:
 *   text  what the words do: stock vocabulary, hype, filler, figurative verbs, unsupported
 *         claims, numbers with no base, chatbot residue, layout tells, rhythm metrics
 *   look  what the markup and CSS do: gradients, gradient text, glass, glow, uppercase labels,
 *         accent rails, emoji used as icons, decorative icons and motion, badge clutter,
 *         palette breadth, and the same choices made through Tailwind classes
 *
 * It never decides whether anything was generated. It reports where to look, with line
 * numbers in the original file, so two reviews of the same file agree.
 *
 * Source of truth: skills/common/humanizer/scripts/slop-scan.mjs. codemie-html-report ships a
 * byte-identical copy.
 *
 *   node slop-scan.mjs <file> [--full | --json] [--text-only | --look-only]
 *                      [--fail-on high|medium|low] [--fail-on-look high|medium|low]
 *   cat page.html | node slop-scan.mjs --stdin [--html | --css | --md]
 *   node slop-scan.mjs --self-test
 *
 * Exit codes: 0 done, 1 usage or read error, 2 actionable findings at or above --fail-on, or
 * look findings at or above --fail-on-look.
 *
 * Not scanned: code fences, front matter, inline code, URLs, quoted spans, <script>, <pre>,
 * <code>, any element carrying data-slop-ignore, and regions between slop:ignore-start
 * and slop:ignore-end comments, in HTML or CSS.
 *
 * Zero dependencies. Node 18+.
 */

import { readFileSync, realpathSync } from 'node:fs';
import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Adds every item to a list one by one: a rule can match hundreds of thousands of times, more than a spread call takes. */
const append = (list, items) => {
  for (const item of items) list.push(item);
};

/* ================================================================== TEXT LAYER */

/* ------------------------------------------------------------------ vocabulary */

// Individually harmless, collectively diagnostic. Density matters, not presence.
const STOCK_WORDS = [
  'delve', 'delves', 'delving', 'tapestry', 'testament', 'underscore', 'underscores', 'underscoring',
  'pivotal', 'crucial', 'vital', 'intricate', 'intricacies', 'interplay',
  'showcase', 'showcases', 'showcasing', 'foster', 'fosters', 'fostering',
  'garner', 'garnered', 'leverage', 'leveraging', 'leverages', 'leveraged',
  'seamless', 'seamlessly', 'robust', 'holistic', 'nuanced',
  'landscape', 'realm', 'myriad', 'plethora', 'multifaceted',
  'unwavering', 'meticulous', 'meticulously', 'profound', 'profoundly',
  'transformative', 'groundbreaking', 'revolutionary', 'game-changing',
  'cutting-edge', 'state-of-the-art', 'unprecedented', 'unparalleled',
  'vibrant', 'bustling', 'nestled', 'breathtaking', 'stunning', 'renowned',
  'boasts', 'boasting', 'elevate', 'elevates', 'elevating',
  'empower', 'empowers', 'empowering', 'unlock', 'unlocks', 'unlocking',
  'harnessing', 'navigate', 'navigating', 'embark',
  'paradigm', 'synergy', 'synergies', 'ecosystem',
  'comprehensive', 'streamline', 'streamlined', 'streamlining',
  'cornerstone', 'bedrock', 'catalyst', 'trailblazing',
  'resonate', 'resonates', 'resonating',
  'enhance', 'enhances', 'enhanced', 'enhancing',
  'facilitate', 'facilitates', 'facilitating',
  'utilize', 'utilizes', 'utilizing', 'utilization', 'utilise', 'utilising',
  // hype that the humanizer list does not carry
  'supercharge', 'supercharged', 'supercharges', 'turbocharge', 'turbocharged',
  'unleash', 'unleashes', 'unleashing', 'reimagine', 'reimagined', 'reimagining',
  'redefine', 'redefines', 'redefining', 'revolutionize', 'revolutionizes', 'revolutionizing',
  'revolutionise', 'revolutionising', 'next-gen', 'next-generation',
  'frictionless', 'effortless', 'effortlessly', 'innovative', 'powerful', 'intuitive',
  'impactful', 'superpower', 'superpowers', 'mission-critical', 'future-proof',
  'blazing-fast', 'lightning-fast',
  // newer model favourites (blader's humanizer, v3.1.0)
  'bolster', 'bolsters', 'bolstered', 'bolstering', 'enduring', 'quietly', 'valuable',
  'exemplify', 'exemplifies',
];

const FILLER = [
  'in order to', 'due to the fact that', 'at this point in time', 'in the event that',
  'has the ability to', 'have the ability to', 'it is important to note that',
  'it is worth noting that', 'it should be noted that', 'needless to say',
  'when it comes to', 'in terms of', 'for all intents and purposes',
  'the fact of the matter is', 'at the end of the day', 'in today’s world',
  "in today's world", 'in the world of', 'in the modern era', 'in an era where',
  'plays a key role', 'plays a crucial role', 'plays a vital role', 'plays a pivotal role',
  'plays a significant role', 'plays an important role', 'play a key role', 'play a crucial role',
  'serves as a', 'stands as a', 'is a testament to', 'a wide range of',
  'a variety of', 'various different', 'it goes without saying', 'at the forefront of',
  'in the realm of', 'ever-evolving', 'ever-changing', 'fast-paced', 'rapidly evolving',
  'in the digital age', 'in this day and age', "it's important to note", 'it’s important to note',
  'it is crucial to', 'it is essential to', 'additionally,', 'functions as a', 'functions as an',
];

const HEDGES = [
  'generally', 'typically', 'often', 'usually', 'sometimes', 'frequently',
  'arguably', 'potentially', 'possibly', 'perhaps', 'maybe', 'somewhat',
  'relatively', 'fairly', 'rather', 'quite', 'largely', 'broadly',
  'may', 'might', 'could', 'tend to', 'tends to', 'can help', 'may vary',
  'in most cases', 'in many cases', 'to some extent', 'more or less',
];

const VAGUE_SOURCE = [
  'experts say', 'experts argue', 'experts believe', 'experts agree', 'according to experts',
  'studies show', 'studies have shown', 'research shows', 'research suggests', 'research indicates',
  'industry reports', 'observers have', 'critics argue', 'some critics',
  'it is widely', 'it is believed', 'many believe', 'analysts predict',
  'according to some', 'sources suggest', 'reports indicate', 'statistics show', 'surveys show',
  'a growing body of', 'increasingly recognized', 'widely regarded',
  'many organizations report', 'many organisations report', 'many companies report',
  'many teams report', 'industry leaders',
];

const CHATBOT = [
  'i hope this helps', 'let me know if', 'feel free to ask', 'would you like me to',
  'want me to', 'should i continue', 'certainly!', 'of course!', 'great question',
  "you're absolutely right", 'you are absolutely right', 'happy to help with',
  'as an ai', 'as a language model', 'i cannot browse', 'as of my last',
  'up to my last training', 'based on available information',
  "here's a breakdown", 'here is a breakdown', "here's an overview", 'in summary,',
  "i'd be happy to", 'i’d be happy to', 'absolutely!', 'great point', 'feel free to reach out',
  "don't hesitate to", 'don’t hesitate to', 'hope you find this', 'happy coding', 'stay tuned',
];

const ANNOUNCE = [
  "let's dive in", 'lets dive in', "let's dive into", "let's explore", "let's break",
  "let's take a look", 'here’s what you need to know', "here's what you need to know",
  'without further ado', 'now, let’s', "now, let's", 'buckle up', 'read on to',
  'in this section, we will', 'in this article, we will', 'we will explore',
  'first things first', "now let's look at", 'now let’s look at',
];

const FAKE_DEPTH = [
  'at its core', 'the real question is', 'the deeper issue', 'the heart of the matter',
  'what really matters', 'fundamentally,', 'in reality,', 'the truth is',
  'let’s be honest', "let's be honest", 'real talk', "here's the thing",
  'here is the thing', 'the bottom line is', 'make no mistake',
  'this is not just', "this isn't just", 'it’s not just', "it's not just",
  'more than ever', 'now more than ever', 'in a world where', 'the thing is,', 'honestly?',
];

// The 2025–2026 social-post register: a hook, a reveal, a staged pause.
const HOOKS = [
  "here's why", 'here’s why', "here's how", 'here’s how', 'the result?', 'the answer?',
  'the catch?', 'the best part?', 'the kicker', 'spoiler:', 'plot twist', 'let that sink in',
  'read that again', 'changes everything', 'the uncomfortable truth', 'the hard truth',
  'the harsh truth', 'what if i told you', 'imagine a world', 'game over', 'no fluff',
  "it's that simple", 'it’s that simple', 'simple as that', 'quietly reshaping',
  'quietly transforming', 'quietly becoming', 'a new era', 'the next frontier', 'new frontier',
  // closers that restate the point or explain the example just shown
  'that distinction matters', "that's the real win", 'that’s the real win', 'that is the real win',
  'this shows the importance of', 'the message was clear',
];

// The rest of this block follows the newer patterns of blader's humanizer (MIT, v3.1.0).

// An ordinary fact dressed as a turning point, a legacy or a bright future.
const SIGNIFICANCE = [
  'the future looks bright', 'the future is bright', 'exciting times ahead', 'a step in the right direction',
  'despite these challenges', 'despite these hurdles', 'continues to thrive', 'indelible mark',
  'lasting legacy', 'enduring legacy', 'marks a turning point', 'marked a turning point',
  'underscores the importance', 'highlights the importance', 'reflects a broader',
];

// Answers to an objection nobody raised, usually left over from an earlier draft.
const PHANTOM = [
  'to be clear,', "don't get me wrong", 'don’t get me wrong', "i'm not saying", 'i’m not saying',
  'this is not to say', "this isn't to say", 'this isn’t to say', 'one might be tempted',
  'you might be tempted', 'it may be tempting to', 'it might be tempting to', 'a tempting approach',
  'an obvious approach would be', 'it would be easy to just', 'some might say', 'some may argue',
  'some would argue', "this isn't about", 'this isn’t about', 'this is not about', "it's not about",
  'it’s not about', 'it is not about',
];

// Where the model's knowledge ended, or the admission that it found no source.
const KNOWLEDGE_LIMIT = [
  'specific details are limited', 'not widely documented', 'maintains a low profile',
  'keeps personal details private', 'in the provided sources', 'based on the provided sources',
  'based on the available sources',
];

// Prestige outlets standing in for what was said.
const OUTLETS = ['as featured in', 'several publications', 'leading publications'];

// Writing about the page instead of its subject.
const SELF_RE = new RegExp([
  String.raw`\b(?:the|this) (?:table|chart|diagram|figure|graph|list|matrix|timeline|grid|section) (?:below|above) (?:shows|compares|lists|summari[sz]es|outlines|illustrates|presents|highlights|details|captures|breaks down|maps)\b`,
  String.raw`\b(?:below|above),? (?:you(?:'|’)ll|you will|you can) (?:find|see)\b`,
  String.raw`\bthis (?:report|page|document|section|dashboard|overview|summary|guide|article|post|deck|proposal|analysis) (?:provides|presents|outlines|covers|offers|gives|explores|describes|summari[sz]es|walks (?:you )?through|aims to|is (?:organi[sz]ed|structured|designed|intended)|was (?:generated|compiled|assembled|created|written|built|prepared|produced))\b`,
  String.raw`\b(?:was|were|has been|have been) (?:added|introduced|created) to replace\b`,
  String.raw`\b(?:flagged|marked) rather than (?:guessed|invented|assumed)\b`,
  String.raw`\b(?:compiled|generated|assembled|gathered) from (?:the )?(?:available|provided|public|multiple|various|several) (?:sources|data|information|materials)\b`,
].join('|'), 'i');

// A contrast staged across two sentences, and the clipped form (", no guessing").
const SPLIT_CONTRAST = [
  [/\b(?:does|do|did) ?(?:not|n't|n’t) mean\b/i, /^(?:it|this|that) (?:means|meant)\b/i],
  [/\b(?:is|are|was|were) ?(?:not|n't|n’t) (?:really |just |only )?about\b/i,
    /^(?:it|this|that|they)(?:'s|’s|'re|’re| is| are| was| were) (?:really |all )?about\b/i],
];
const CLIPPED_TAIL = /[,—–]\s*no (?:more )?(?:guessing|guesswork|fluff|surprises|hassle|drama|headaches|friction|boilerplate|exceptions|excuses|shortcuts|nonsense|magic)[.!]?\s*$/i;

// Figurative verbs and stock metaphors: say what happens instead.
const FIGURATIVE = [
  'travel with', 'travels with', 'travelling with', 'traveling with', 'ride along', 'rides along',
  'hold the line', 'holds the line', 'at the heart of', 'the backbone of', 'bridge the gap',
  'bridges the gap', 'bridging the gap', 'move the needle', 'moves the needle',
  'low-hanging fruit', 'single pane of glass', 'unlock value', 'unlocks value',
  'unlock the power', 'unlock the full potential', 'full potential', 'drive value', 'drives value',
  'drive growth', 'drives growth', 'drive innovation', 'drives innovation', 'drive efficiency',
  'drives efficiency', 'driving innovation', 'driving growth',
  'secret sauce', 'north star', 'game changer', 'game-changer', 'paradigm shift', 'perfect storm',
  'double-edged sword', 'heavy lifting', 'next level', 'level up', 'raise the bar', 'raises the bar',
  'set the stage', 'sets the stage', 'setting the stage', 'pave the way', 'paves the way', 'one-stop shop',
  'all-in-one', 'seat at the table', 'tip of the iceberg', 'the glue that', 'at your fingertips',
  'with ease', "in the driver's seat", 'in the driver’s seat', 'harness the', 'aligned with business',
  'align with business', 'aligned with our', 'align stakeholders', 'stakeholder alignment',
  'strategic alignment',
];

// Corporate and field jargon: fine between specialists, slop on a page for anyone else.
const JARGON = [
  'learnings', 'value-add', 'circle back', 'touch base', 'boil the ocean', 'thought leadership',
  'best-of-breed', 'operationalize', 'operationalise', 'actionable insights', 'bandwidth to',
];

// Words the shared glossary (references/glossary.md) replaces, with the word to use instead.
// Internal names must never reach a client page; the other two groups differ in how often the
// avoided word is also fine in another sense.
const INTERNAL_NAMES = [
  ['flywheel', 'compounding: say what gets reused. Flywheel is internal only'],
  ['ifactory', 'AI/Run Hyperfactory'],
  ['factory umbrella', 'AI/Run Hyperfactory'],
  ['dark factory', 'the Autonomous flow. Dark Factory is internal only'],
];
const GLOSSARY = [
  ['background agent', 'headless agent, or workflow agent inside a business service'],
  ['digital worker', 'workflow agent'],
  ['smart routing', 'model routing'],
  ['model gateway', 'AI gateway'],
  ['workhorse', 'the medium tier (fast, medium, frontier)'],
  ['golden dataset', 'test set'],
  ['eval suite', 'test set'],
  ['llm-as-judge', 'judge model'],
  ['llm-as-a-judge', 'judge model'],
  ['llm as a judge', 'judge model'],
  ['ai grader', 'judge model'],
  ['vibe check', 'error analysis'],
  ['shadow ai list', 'AI inventory'],
  ['micro pod', 'pod'],
  ['customer promise', 'assistant scope'],
  ['jailbreak list', 'hostile set'],
  ['red-team suite', 'hostile set'],
];
const GLOSSARY_CONTEXT = [
  ['hitl', 'who approves what: "the tech lead approves the plan"'],
  ['human-in-the-loop', 'who approves what: "the tech lead approves the plan"'],
  ['scoped', 'what it reaches: "only their projects, only the rights the work needs"'],
  ['story point', 'complexity point, in our pricing model'],
  ['developer day', 'complexity point'],
  ['deliverables', 'what we hand over, by name'],
  ['blueprint', 'decision pack, or say what it is'],
  ['use case', 'customer task, business service or job'],
  ['value stream', 'business service'],
  ['cognitive load', 'thinking load'],
  ['power user', 'champion'],
  ['knowledge transfer', 'hand-over: Lead, Pair, Coach, On call'],
  ['proof of concept', 'Jump-Start or calibration'],
  ['telemetry', 'trace'],
  ['chatbot', 'product assistant'],
  ['deflection', 'completed customer task'],
  ['lightweight mode', 'the Light flow'],
  ['lightweight flow', 'the Light flow'],
  ['ai champion', 'champion'],
  ['online eval', 'live score, for one result; Online Evals is the practice'],
  ['plugin marketplace', 'package repository'],
  ['coding assistant', 'harness for the tool, factory for the workflow'],
];

const AI_LABEL = [
  'ai-powered', 'ai powered', 'powered by ai', 'ai-driven', 'ai driven', 'ai-first',
  'built with ai', 'with the power of ai', 'magic of ai', 'ai magic',
];

const SOCIAL_PROOF_RE = /\b(?:(?:trusted|loved|used|chosen|relied on) by (?:over |more than )?(?:\d[\d,.]*\s?[km]?\+?|thousands|millions|hundreds|teams at|leading|top|the world['’]s|fortune)|join (?:over |more than )?(?:\d[\d,.]*\s?[km]?\+?|thousands|millions)|(?:teams|customers|companies|developers) (?:worldwide|around the world))/i;

const STOCK_HEADINGS = [
  'key takeaways', 'key takeaway', 'final thoughts', 'in conclusion', 'conclusion',
  'challenges and opportunities', 'future outlook', 'looking ahead', 'the road ahead',
  'why it matters', 'what this means', 'benefits and challenges', 'pros and cons',
  'introduction', 'overview', 'closing thoughts', 'wrapping up', 'tl;dr',
  'why choose us', 'key features', 'key benefits', 'key insights', 'key highlights',
  'the bottom line', 'final verdict', "what's next", 'what’s next', 'next steps', 'the future of',
  'pro tip', 'pro tips', 'quick tip', 'fun fact', 'did you know', 'our approach', 'the solution',
  'the problem',
];

// Product and tool names that can line up by chance.
const PRODUCT_NAMES = new Set(['Code', 'Codex', 'Cursor', 'Copilot', 'Claude', 'Cline', 'Continue', 'Gemini', 'GitHub',
  'GitLab', 'Jira', 'Confluence', 'Kiro', 'Windsurf', 'Bedrock', 'Azure', 'Sonnet', 'Opus', 'Haiku']);

// Uppercase words that are names or conventions, not shouted labels.
const ALLCAPS_OK = new Set([
  'README', 'LICENSE', 'CHANGELOG', 'CONTRIBUTING', 'AGENTS', 'CLAUDE', 'GEMINI', 'TODO', 'FIXME',
  'NOTE', 'WARNING', 'IMPORTANT', 'DEPRECATED', 'BREAKING', 'CAUTION', 'DANGER', 'REQUIRED',
  'OPTIONAL', 'NEEDS', 'MUST', 'SHOULD', 'SHALL', 'RECOMMENDED', 'GDPR', 'HIPAA', 'SOC',
]);

// Tokens that count as evidence: a number, a percentage, a currency amount, a date, a version.
const EVIDENCE_RE = /(\$\s?\d|\d+\s?%|\b\d[\d,._]*\b|\bv?\d+\.\d+\b|\b(19|20)\d{2}\b)/;

// A claim of effect with no evidence in the same sentence is the "water" signature.
// An effect verb is a claim only when it acts on a benefit: "cuts costs", "will improve
// onboarding", "productivity increased". "A browser drives the feature" and "a task to deliver"
// are descriptions. "Delivered" is past work, so only "delivers" can promise.
const EFFECT = 'improve|increase|reduce|decrease|boost|deliver|enable|ensure|optimi[sz]e|accelerate|streamline|enhance|strengthen|speed up|cut';
const EFFECT_PAST = EFFECT.replace('deliver|', '');
const EFFECT_ING = 'improving|increasing|reducing|decreasing|boosting|delivering|enabling|ensuring|optimi[sz]ing|accelerating|streamlining|enhancing|strengthening|speeding up|cutting';
const BENEFIT = 'productivity|efficiency|efficiencies|quality|performance|costs?|spend|time|outcomes?|experiences?|reliability|security|scalability|collaboration|velocity|speed|throughput|satisfaction|engagement|revenue|growth|risks?|errors?|defects?|downtime|latency|value|roi|margins?|conversion|retention|adoption|delivery|innovation|agility|resilience|visibility|compliance|accuracy|uptime|availability|time-to-market|onboarding|operations|decision-making|decisions|insights|results|impact|overhead|toil|friction|complexity|bottlenecks?|waste|workflows?|processes|output|success';
const DEGREE_NOUN = 'improvement|impact|increase|reduction|decrease|gain|benefit|saving|growth|difference|change|boost|uplift|speedup';
const VERB_FORMS = `(?:will|would|can|could|shall|to|helps?|helping)\\s+(?:\\w+\\s+){0,2}(?:${EFFECT})|(?:${EFFECT})s|(?:${EFFECT_PAST})(?:ed|d)|${EFFECT_ING}`;
const CLAIM_RE = new RegExp(
  '\\b(?:significantly|dramatically|substantially|considerably|markedly' +
  `|(?:significant|dramatic|substantial|considerable|marked)\\s+(?:\\w+\\s+)?(?:${DEGREE_NOUN})s?\\b` +
  '|best-in-class|world-class|industry-leading' +
  `|(?<!-)(?:${VERB_FORMS})\\b(?:\\W+[\\w-]+){0,4}?\\W+(?:${BENEFIT})\\b` +
  `|(?:${BENEFIT})\\b(?:\\W+[\\w-]+){0,3}?\\W+(?:(?:${EFFECT})s|(?:${EFFECT_PAST})(?:ed|d))\\b)`,
  'i',
);

// Numbers that promise a comparison and never say against what.
// A multiplier only counts when it promises a gain: "10x faster", "up to 5x ROI". Sizes ("1280 × 720")
// and zoom levels ("2× zoom") are not claims.
const MULT_RE = /(?<![\w.])\d+(?:[.,]\d+)?\s?[x×](?!\s?\d)(?![\w-])\s+(?:[\w-]+\s+){0,2}?(?:faster|quicker|slower|more|less|fewer|cheaper|better|higher|lower|productiv\w*|improvement|roi|return|growth|speed\w*|output|throughput|velocity|efficien\w*|boost|gains?|increase|reduction|savings?)\b/i;
const PCT_COMPARE_RE = /\b\d+(?:\.\d+)?\s?%\s+(?:faster|slower|quicker|more|less|fewer|higher|lower|better|cheaper|reduction|increase|decrease|improvement|savings?|boost|gain|uplift|productivity|efficiency)\b/i;
// Starts only where a number starts, so a long run of digits is read once, not once per digit.
const PLUS_RE = /(?<![\w.,])\d[\d,.]*\s?(?:k|m)?\+(?=\s|$|[),.;:!?])/i;
const BASE_RE = /\b(?:than|vs\.?|versus|compared|from|baseline|before|after|relative|per|out of|since|over the|median|average|mean|of (?:the|our|all|today|its|their)|in (?:19|20)\d{2}|(?:19|20)\d{2})\b/i;

// Emoji only. Arrows, check marks and box drawing are legitimate prose and table markers.
const EMOJI_SEQ = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{2712}\u{2719}-\u{27BF}\u{2B50}\u{2B55}]️?(?:‍[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]️?)*/gu;

/* ------------------------------------------------------------------ text: preparation */

/**
 * Convert HTML to the markdown shape the prose checks expect. Emphasis, headings, list items
 * and table rows keep their structure, because the layout tells live in exactly that shape.
 * Code and preformatted text become code spans and fences so they are never read as prose.
 */
export function htmlToText(html) {
  const inner = (h) => h.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    // Speaker notes are prose a presenter reads aloud: scan them as a paragraph after their tag.
    // A line marker inside the tag (see htmlToTextMapped) moves out with them, so they map to their line.
    .replace(/(<[a-z][\w-]*\b[^>]*?)\sdata-notes\s*=\s*(["'])([\s\S]*?)\2([^>]*>)/gi, (m, open, _q, notes, close) =>
      `${open}${close}\n${(open.match(/\u0001\d+\u0002/g) || []).join('')}${notes}\n\n`)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (m, h) => `\n\`\`\`\n${h.replace(/<[^>]+>/g, '')}\n\`\`\`\n`)
    .replace(/<(code|kbd|samp)\b[^>]*>([\s\S]*?)<\/\1>/gi, (m, _t, h) => (inner(h) ? '`' + inner(h).replace(/`/g, "'") + '`' : ''))
    .replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (m, _t, h) => (inner(h) ? `**${inner(h)}**` : ''))
    .replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (m, _t, h) => (inner(h) ? `*${inner(h)}*` : ''))
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (m, lvl, h) => `\n${'#'.repeat(Number(lvl))} ${inner(h)}\n`)
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<tr\b[^>]*>/gi, '\n| ')
    .replace(/<\/t[dh]>/gi, ' | ')
    .replace(/<\/(p|div|li|tr|section|article|header|footer|blockquote|ul|ol|dt|dd|figcaption|caption|summary|details|aside|main|nav|table|thead|tbody|tfoot|button|text|title)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(Number(d)))
    .replace(/&[mn]dash;/g, '—')
    .replace(/&[rl]squo;/g, '’')
    .replace(/&[rl]dquo;/g, '"')
    .replace(/&hellip;/g, '…')
    .replace(/&rarr;/g, '→')
    .replace(/&middot;/g, '·')
    .replace(/\n{3,}/g, '\n\n');
}

const MARK = (n) => `\u0001${n}\u0002`;
const MARK_RE = /\u0001(\d+)\u0002/g;

/**
 * htmlToText with a map from every output line back to its source line. Each source line is
 * prefixed with an invisible marker; the markers survive the conversion as plain text, and the
 * marker nearest before a line's first visible character names its source line.
 */
export function htmlToTextMapped(html) {
  const marked = html.split('\n').map((l, i) => MARK(i + 1) + l).join('\n');
  const out = htmlToText(marked).split('\n');
  const map = [];
  let last = 1;
  const lines = out.map((l) => {
    const visible = l.replace(MARK_RE, (m) => '\u0000'.repeat(m.length));
    const first = visible.search(/[^\s\u0000]/);
    let src = last;
    for (const m of l.matchAll(MARK_RE)) {
      if (first !== -1 && m.index > first) break;
      src = Number(m[1]);
    }
    for (const m of l.matchAll(MARK_RE)) last = Number(m[1]);
    map.push(first === -1 ? last : src);
    return l.replace(MARK_RE, '');
  });
  return { text: lines.join('\n'), map };
}

const lineIndex = (src) => {
  const nl = [];
  for (let i = 0; i < src.length; i++) if (src.charCodeAt(i) === 10) nl.push(i);
  return (idx) => {
    let lo = 0;
    let hi = nl.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (nl[mid] < idx) lo = mid + 1;
      else hi = mid;
    }
    return lo + 1;
  };
};

/** Prose string values of a JSON content file, each mapped to its line. Keys never count. */
export function jsonToTextMapped(src) {
  let data;
  try {
    data = JSON.parse(src);
  } catch {
    return null;
  }
  const lineOf = lineIndex(src);
  const SKIP_KEY = /^(id|key|keys|href|url|uri|src|icon|kind|type|class|classname|cls|style|slug|route|path|ref|refs|color|colour|tone|variant|layout|anchor|lang|locale|format|unit|units|date|version|mime|target|rel|query|regex|pattern)$/i;
  const lines = [];
  const map = [];
  let cursor = 0;
  let lastLine = 1;
  // Content sits a few levels deep; past 200, nesting is data, and walking it would exhaust the stack.
  const walk = (v, key, depth = 0) => {
    if (depth > 200) return;
    if (typeof v === 'string') {
      const t = v.trim();
      if (key && SKIP_KEY.test(key)) return;
      if ((t.match(/\S+/g) || []).length < 3 || !/\p{L}/u.test(t)) return;
      if (/^(https?:|mailto:|\/|#)/.test(t)) return;
      const enc = JSON.stringify(v).slice(1, -1);
      let idx = src.indexOf(enc, cursor);
      if (idx === -1) idx = src.indexOf(enc.slice(0, 32), cursor);
      if (idx !== -1) {
        cursor = idx + 1;
        lastLine = lineOf(idx);
      }
      lines.push(t.replace(/\s*\n\s*/g, ' '), '');
      map.push(lastLine, lastLine);
    } else if (Array.isArray(v)) {
      for (const x of v) walk(x, key, depth + 1);
    } else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) walk(x, k, depth + 1);
    }
  };
  walk(data, '');
  return { text: lines.join('\n'), map };
}

/** Visible text of a component file: JSX or template text, UI props, and copy in data arrays. */
export function componentToTextMapped(src) {
  const lineOf = lineIndex(src);
  const hits = [];
  const code = /[=;&|(){}[\]]|=>|\$\{/;
  // Each hit is placed at its text's first character, so a value on the line after its
  // property, or JSX text below its tag, is reported on the line it is on.
  for (const m of src.matchAll(/>([^<>{}]*\p{L}[^<>{}]*)</gu)) {
    const t = m[1].replace(/\s+/g, ' ').trim();
    if (t.split(' ').length < 2 || code.test(t)) continue;
    hits.push({ idx: m.index + 1 + m[1].search(/\S/), t });
  }
  const PROP = /\b(?:title|alt|placeholder|aria-label|label|description|subtitle|heading|caption|tooltip)\s*=\s*(["'])([^"'\n]{3,})\1/g;
  for (const m of src.matchAll(PROP)) hits.push({ idx: m.index + m[0].indexOf(m[2]), t: m[2].trim() });
  const FIELD = /\b(?:title|description|desc|text|label|heading|subheading|subtitle|body|content|cta|tagline|quote|summary|caption|headline|eyebrow|badge|name)\s*:\s*(["'`])((?:(?!\1)[^\\\n]|\\.){3,})\1/g;
  for (const m of src.matchAll(FIELD)) hits.push({ idx: m.index + m[0].indexOf(m[2]), t: m[2].replace(/\\(.)/g, '$1').trim() });
  hits.sort((a, b) => a.idx - b.idx);
  const lines = [];
  const map = [];
  for (const h of hits) {
    lines.push(h.t, '');
    const ln = lineOf(h.idx);
    map.push(ln, ln);
  }
  return { text: lines.join('\n'), map };
}

/**
 * Classify each line so prose checks never fire inside code, front matter or quoted material.
 * Quoted lines are reported separately and are never "fix here" findings.
 */
export function classifyLines(text) {
  const raw = text.split('\n');
  const out = [];
  let inFence = false;
  let fenceMark = '';
  let inFrontMatter = false;

  for (let i = 0; i < raw.length; i++) {
    const line = raw[i];
    const trimmed = line.trim();
    let kind = 'prose';

    if (i === 0 && trimmed === '---') {
      inFrontMatter = true;
      out.push({ n: 1, raw: line, kind: 'meta', text: '' });
      continue;
    }
    if (inFrontMatter) {
      if (trimmed === '---' || trimmed === '...') inFrontMatter = false;
      out.push({ n: i + 1, raw: line, kind: 'meta', text: '' });
      continue;
    }

    const fence = trimmed.match(/^(`{3,}|~{3,})/);
    if (fence) {
      if (!inFence) {
        inFence = true;
        fenceMark = fence[1][0];
      } else if (fence[1][0] === fenceMark) {
        inFence = false;
        fenceMark = '';
      }
      out.push({ n: i + 1, raw: line, kind: 'code', text: '' });
      continue;
    }
    if (inFence) {
      out.push({ n: i + 1, raw: line, kind: 'code', text: '' });
      continue;
    }

    if (/^\s*>/.test(line)) kind = 'quote';
    else if (/^\s*#{1,6}\s/.test(line)) kind = 'heading';
    else if (/^\s*\|/.test(line)) kind = 'table';
    else if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(trimmed)) kind = 'rule';
    else if (trimmed === '') kind = 'blank';

    // Mask spans that are never prose: inline code, link targets, bare URLs, and short quoted
    // spans, which are being discussed rather than asserted.
    let quotedSpans = 0;
    const blank = (m) => ' '.repeat(m.length);
    const masked = line
      .replace(/`[^`]*`/g, blank)
      .replace(/\]\([^)]*\)/g, blank)
      .replace(/<https?:\/\/[^>]*>/g, blank)
      .replace(/\bhttps?:\/\/\S+/g, blank)
      .replace(/[“"][^“”"]{1,160}[”"]/g, (m) => { quotedSpans++; return blank(m); });

    out.push({ n: i + 1, raw: line, kind, text: masked, quoted_spans: quotedSpans });
  }
  return out;
}

/** Sentence split that tolerates common abbreviations and decimals. */
export function splitSentences(text) {
  // \u0003 and \u0004 hold the periods of abbreviations and decimals while the text is split.
  const guarded = text
    .replace(/\b(Mr|Mrs|Ms|Dr|Prof|Inc|Ltd|Corp|St|vs|etc|e\.g|i\.e|approx|Fig|No)\./gi, '$1\u0003')
    .replace(/(\d)\.(\d)/g, '$1\u0004$2');
  return guarded
    .split(/(?<=[.!?])[)"'”’]?\s+/)
    .map((s) => s.replace(/\u0003/g, '.').replace(/\u0004/g, '.').trim())
    .filter((s) => s.length > 0);
}

const words = (s) => (s.match(/[\p{L}\p{N}'’-]+/gu) || []);

function stdev(nums) {
  if (nums.length < 2) return 0;
  const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
  const v = nums.reduce((a, b) => a + (b - mean) ** 2, 0) / (nums.length - 1);
  return Math.sqrt(v);
}

/** Latin-script share; below 0.6 means the English pattern lists do not apply. */
export function latinShare(text) {
  const letters = text.match(/\p{L}/gu) || [];
  if (letters.length === 0) return 1;
  const latin = text.match(/[A-Za-zÀ-ɏ]/g) || [];
  return latin.length / letters.length;
}

/* ------------------------------------------------------------------ text: checks */

const finding = (layer, rule, severity, line, match, excerpt, note, extra = {}) => ({
  layer, rule, severity, line, match, excerpt, note, in_quote: false, ...extra,
});

function findPhrases(lines, phrases, rule, severity, note) {
  const found = [];
  for (const l of lines) {
    if (l.kind === 'code' || l.kind === 'meta' || l.kind === 'blank') continue;
    const lower = l.text.toLowerCase();
    for (const p of phrases) {
      let idx = lower.indexOf(p);
      while (idx !== -1) {
        const before = idx === 0 ? ' ' : lower[idx - 1];
        const after = lower[idx + p.length] ?? ' ';
        const wordish = /[\p{L}\p{N}]/u;
        if (!wordish.test(before) && !(wordish.test(after) && /[\p{L}]$/u.test(p))) {
          found.push(finding('text', rule, severity, l.n, l.text.slice(idx, idx + p.length).trim(),
            l.raw.trim().slice(0, 160), note, { in_quote: l.kind === 'quote' }));
        }
        idx = lower.indexOf(p, idx + p.length);
      }
    }
  }
  return found;
}

function findRegex(lines, re, rule, severity, note, kinds) {
  const found = [];
  for (const l of lines) {
    if (l.kind === 'code' || l.kind === 'meta' || l.kind === 'blank') continue;
    if (kinds && !kinds.includes(l.kind)) continue;
    const rx = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    let m;
    while ((m = rx.exec(l.text)) !== null) {
      found.push(finding('text', rule, severity, l.n, m[0].trim().slice(0, 80),
        l.raw.trim().slice(0, 160), note, { in_quote: l.kind === 'quote' }));
      if (m[0].length === 0) rx.lastIndex++;
    }
  }
  return found;
}

/** The text layer. `emoji` is false for HTML, where the look layer judges emoji by their tag. */
export function scanText(text, { emoji = true } = {}) {
  const lines = classifyLines(text);
  const prose = lines.filter((l) => ['prose', 'heading', 'quote', 'table'].includes(l.kind));
  const proseText = prose.filter((l) => l.kind !== 'quote').map((l) => l.text).join('\n');
  const allWords = words(proseText);
  const wc = allWords.length;
  const per1k = (n) => (wc === 0 ? 0 : Math.round((n / wc) * 100000) / 100);

  const findings = [];

  append(findings, findRegex(prose, /[—–]|(?<=\s)--(?=\s)/, 'dash', 'low',
    'Em/en dash. Legitimate in edited prose; evidence only alongside other tells.'));
  append(findings, findRegex(prose, /[“”‘’]/, 'curly-quote', 'info',
    'Curly quotes. Word, Docs and macOS produce these; never a tell on its own.'));

  if (emoji) {
    for (const l of prose) {
      for (const m of l.text.matchAll(EMOJI_SEQ)) {
        const lead = l.text.slice(0, m.index).trim();
        const icon = l.kind === 'heading' || /^(?:[-*+]|\d+\.)?\s*(?:\*\*)?$/.test(lead);
        if (l.kind === 'table') {
          findings.push(finding('text', 'emoji-data', 'info', l.n, m[0], l.raw.trim().slice(0, 160),
            'Emoji in a table cell. Fine when it is data, such as a status.', { in_quote: false }));
        } else {
          findings.push(finding('text', icon ? 'emoji-icon' : 'emoji', icon ? 'high' : 'medium', l.n, m[0],
            l.raw.trim().slice(0, 160),
            icon ? 'Emoji used as an icon on a heading or list item.' : 'Decorative emoji in running text.',
            { in_quote: l.kind === 'quote' }));
        }
      }
    }
  }

  // `- **Label:** text`. A bold label that is a path, identifier or code span is a definition
  // list, which is legitimate structure; only a natural-language label is the mini-heading tell.
  const BOLD_LABEL = /^\s*(?:[-*+]|\d+\.)\s+(?:\*\*|__)([^*_]{2,60}?)(:)?(?:\*\*|__)\s*([:—–-])?\s+\S/;
  const bold = [];
  for (const l of prose) {
    const m = l.text.match(BOLD_LABEL);
    if (!m) continue;
    const colon = Boolean(m[2] || m[3] === ':');
    const dash = Boolean(m[3] && m[3] !== ':');
    if (!colon && !dash) continue;
    const label = m[1].trim();
    const isIdentifier = /[`\/\\._]|^[a-z]/.test(label) || /^[A-Z0-9_]+$/.test(label);
    const isPhrase = /^[A-Z][A-Za-zÀ-ɏ]*(?: [A-Za-zÀ-ɏ]+){0,3}$/.test(label);
    let rule = 'definition-list';
    let severity = 'info';
    let note = 'Bold term followed by its definition. Legitimate structure; census only.';
    if (!isIdentifier && isPhrase) {
      rule = 'bold-label-list';
      severity = colon ? 'high' : 'medium';
      note = colon
        ? 'Bold mini-heading plus colon: the strongest layout tell.'
        : 'Bold label with a dash. A tell when the body restates the label, a glossary when it does not.';
    }
    bold.push(finding('text', rule, severity, l.n, label, l.raw.trim().slice(0, 160), note,
      { in_quote: l.kind === 'quote' }));
  }
  // Runs of consecutive bold-label items, blank lines allowed. Eight or more in a row is a
  // glossary or an options reference, which the generated mini-heading list never is.
  const listLine = new Set(prose.filter((l) => /^\s*(?:[-*+]|\d+\.)\s/.test(l.text)).map((l) => l.n));
  const nonBlank = lines.filter((l) => l.kind !== 'blank').map((l) => l.n);
  let run = [];
  const flush = () => {
    if (run.length >= 8) {
      for (const f of run) if (f.rule === 'bold-label-list') Object.assign(f, {
        rule: 'definition-list', severity: 'info',
        note: `One of ${run.length} bold terms in a row: reads as a glossary or reference. Check each body defines its term.`,
      });
    }
    run = [];
  };
  for (const f of bold) {
    const prev = run[run.length - 1];
    if (prev) {
      const between = nonBlank.filter((n) => n > prev.line && n < f.line);
      if (between.some((n) => !listLine.has(n))) flush();
    }
    run.push(f);
  }
  flush();
  append(findings, bold);

  append(findings, findRegex(prose, /^#{2,6}\s+(?:[A-Z][a-zÀ-ɏ']+\s+){2,}[A-Z][a-zÀ-ɏ']+\s*$/, 'title-case-heading', 'medium',
    'Title Case heading. Fine if the whole document uses it consistently.', ['heading']));
  append(findings, findRegex(prose, /\b(?:not (?:only|just|merely|simply)\b[^.!?]{0,90}\bbut\b|(?:is|are|was|were|it['’]s|that['’]s|this isn['’]t|isn['’]t|aren['’]t)\s+not\s+(?:just|only|merely|simply)\b)/i, 'not-x-but-y', 'high',
    'The "not X but Y" frame: the negative half names something nobody claimed. State the point.'));
  append(findings, findRegex(prose, /,\s+(highlighting|underscoring|emphasizing|showcasing|reflecting|symbolizing|ensuring|fostering|enabling|allowing|contributing to|cultivating|solidifying|cementing|paving the way|marking|signaling)\b/i, 'ing-tail', 'high',
    'Participial tail that adds interpretation instead of information.'));
  append(findings, findRegex(prose, /\bfrom\s+[^.!?,]{3,40}\s+to\s+[^.!?,]{3,40}\b/i, 'false-range', 'low',
    'A "from X to Y" span. Check that X and Y are the ends of a real range.'));
  append(findings, findRegex(prose, /(?<![\w'’-])(\w[\w'’-]*),\s+(\w[\w'’-]*),\s+and\s+(\w[\w'’-]*)\b/, 'rule-of-three', 'low',
    'A three-item list. Only a tell when the third item is there for cadence.', ['prose', 'heading']));
  // A list of product names ("Claude Code, Codex, Cursor") is not a coined triad.
  append(findings, findRegex(prose, /\b([A-Z])[a-z]{2,},\s+\1[a-z]{2,},?\s+(?:and\s+|&\s+)?\1[a-z]{2,}\b/, 'alliterative', 'medium',
    'An alliterative triad, usually a coined framework name. Use the field\'s own words.')
    .filter((f) => !f.match.split(/[\s,&]+/).some((w) => PRODUCT_NAMES.has(w))));
  append(findings, findRegex(prose, /(?:[$€£]|\b(?:USD|EUR|GBP)\s?)\d[\d,.]*\s?[kKmM]?\s*(?:per|a|an|\/)\s*(?:story point|complexity point|point|hour|day|seat|user|licen[cs]e|month|year|engineer|developer|head|FTE|ticket|task|sprint)s?\b/i, 'price', 'medium',
    'A price or rate. Keep it only if its owner approved it for this page; people quote what they see.'));
  append(findings, findRegex(prose, /\b(?:today|baseline|base|now)\s*=\s*100(?![\d.%]|\s?%|\s?per ?cent)/i, 'index-points', 'medium',
    'Index points. Use a share of a stated base, with % on the figure.'));
  append(findings, findRegex(prose, /^\s*(?:[-*+]|\d+\.)\s+.{0,400}$/, 'list-item', 'info', 'Structural census only.'));
  append(findings, findRegex(prose, /\?\s*$/, 'question-line', 'info',
    'Line ending in a question. Rhetorical questions used as transitions are a tell.'));

  // Shouted labels typed in capitals: "KEY INSIGHT", "TOTAL USERS". Acronyms are left alone.
  for (const l of prose) {
    if (l.kind === 'quote') continue;
    for (const m of l.text.matchAll(/\b[A-Z][A-Z'’&-]+(?:\s+[A-Z][A-Z'’&-]+)+\b|\b[A-Z]{7,}\b/g)) {
      const before = l.text[m.index - 1] || ' ';
      const after = l.text[m.index + m[0].length] || ' ';
      if (/[-_./\\]/.test(before) || /[-_./\\]/.test(after)) continue;
      const ws = m[0].split(/\s+/);
      const long = ws.filter((w) => w.replace(/[^A-Z]/g, '').length >= 5 && !ALLCAPS_OK.has(w));
      if ((ws.length >= 2 && long.length >= 1) || (ws.length === 1 && long.length === 1)) {
        findings.push(finding('text', 'caps-text', 'medium', l.n, m[0], l.raw.trim().slice(0, 160),
          'Label typed in capitals. Write normal case; let the styling decide.'));
      }
    }
  }

  append(findings, findPhrases(prose, STOCK_WORDS, 'stock-word', 'medium',
    'Overused AI vocabulary. Judge by density, not by any single hit.'));
  append(findings, findPhrases(prose, FILLER, 'filler', 'medium', 'Filler that shortens with no loss.'));
  append(findings, findPhrases(prose, VAGUE_SOURCE, 'vague-source', 'high',
    'Attribution to nobody. Name the source or drop the claim; never invent one.'));
  append(findings, findPhrases(prose, CHATBOT, 'chatbot-artifact', 'high',
    'Assistant chatter left inside the document.'));
  append(findings, findPhrases(prose, ANNOUNCE, 'announce', 'high',
    'Announcing the next point instead of making it.'));
  append(findings, findPhrases(prose, FAKE_DEPTH, 'fake-depth', 'high',
    'A staged reveal wrapped around an ordinary claim.'));
  append(findings, findPhrases(prose, HOOKS, 'hook', 'medium',
    'A hook or reveal from social posts. State the point.'));
  append(findings, findPhrases(prose, FIGURATIVE, 'figurative', 'medium',
    'Figurative verb or stock metaphor. Say what actually happens.'));
  append(findings, findPhrases(prose, JARGON, 'jargon', 'low',
    'Corporate or field jargon. On a page for non-specialists, say what it does.'));
  append(findings, findPhrases(prose, SIGNIFICANCE, 'inflated-significance', 'medium',
    'An ordinary fact dressed as a turning point or a bright future. Keep the fact; end on it.'));
  append(findings, findPhrases(prose, PHANTOM, 'phantom-objection', 'medium',
    'An answer to an objection nobody raised. Cut it, or state the claim inside it.'));
  append(findings, findPhrases(prose, KNOWLEDGE_LIMIT, 'knowledge-limit', 'medium',
    'Where the model ran out of sources. Say what the source does not show, or cut it.'));
  append(findings, findPhrases(prose, OUTLETS, 'social-proof', 'medium',
    'Social proof. Keep it only if it is real, sourced and approved.'));
  // Glossary words, singular and plural, each finding naming the word to use instead.
  for (const [list, rule, severity, note] of [
    [INTERNAL_NAMES, 'internal-name', 'medium', 'An internal name. Keep it off client pages; the replacement follows the arrow.'],
    [GLOSSARY, 'glossary', 'medium', 'A word the glossary replaces (references/glossary.md); the replacement follows the arrow.'],
    [GLOSSARY_CONTEXT, 'glossary-context', 'low', 'A word the glossary replaces where it means our concept; the replacement follows the arrow.'],
  ]) {
    for (const [phrase, use] of list) {
      const forms = /[a-z]$/.test(phrase) && !phrase.endsWith('s') ? [phrase, phrase + 's'] : [phrase];
      for (const f of findPhrases(prose, forms, rule, severity, note)) {
        f.excerpt = `"${f.match}" → ${use} | ${f.excerpt}`.slice(0, 220);
        findings.push(f);
      }
    }
  }
  append(findings, findPhrases(prose, AI_LABEL, 'ai-label', 'medium',
    'Labelled as AI instead of saying what it does.'));
  append(findings, findRegex(prose, SOCIAL_PROOF_RE, 'social-proof', 'medium',
    'Social proof. Keep it only if it is real, sourced and approved.'));
  append(findings, findPhrases(prose.filter((l) => l.kind === 'heading'), STOCK_HEADINGS, 'stock-heading', 'medium',
    'Stock section title. Keep it only if the section carries something the body does not.'));

  const sentences = [];
  for (const l of prose) {
    if (l.kind === 'quote' || l.kind === 'table') continue;
    for (const s of splitSentences(l.text)) sentences.push({ s, line: l.n, kind: l.kind });
  }

  // Hedge stacking: two or more hedges inside one sentence.
  for (const { s, line } of sentences) {
    // "As often as" compares frequencies and "rather than" picks one thing over another: neither hedges.
    const lower = ' ' + s.toLowerCase().replace(/\b(?:as|how|so|too|more|less) often\b|\brather than\b/g, ' ') + ' ';
    const hits = HEDGES.filter((h) => lower.includes(' ' + h + ' ') || lower.includes(' ' + h + ','));
    if (hits.length >= 2) {
      findings.push(finding('text', 'hedge-stack', 'high', line, hits.join(' + '), s.slice(0, 160),
        'Several hedges in one sentence. Keep at most the one the evidence supports.'));
    }
  }

  // Unsupported claims: a claim verb with no number, date or currency anywhere in the sentence.
  let claimSentences = 0;
  let unsupported = 0;
  for (const { s, line, kind } of sentences) {
    if (kind === 'heading') continue;
    if (!CLAIM_RE.test(s)) continue;
    claimSentences++;
    if (!EVIDENCE_RE.test(s)) {
      unsupported++;
      findings.push(finding('text', 'unsupported-claim', 'high', line, (s.match(CLAIM_RE) || [''])[0],
        s.slice(0, 160), 'A claim of effect with no number, date or named source in the sentence.'));
    }
  }

  // Numbers with no base: "10x faster", "40% less effort", "500+ teams".
  for (const { s, line } of sentences) {
    const t = s.trim();
    if (/^[~≈<>]?\s?\d[\d.,]*\s?(?:x|×|%|\+|k\+|m\+)$/i.test(t) || /^(?:24\/7|∞)$/.test(t)) {
      findings.push(finding('text', 'bare-stat', 'medium', line, t, t,
        'A big number on its own. Say what it counts, against what base, when, and the source.'));
      continue;
    }
    const m = s.match(MULT_RE) || s.match(PCT_COMPARE_RE) || s.match(PLUS_RE);
    if (!m || BASE_RE.test(s)) continue;
    findings.push(finding('text', 'number-no-base', 'medium', line, m[0], s.slice(0, 160),
      'A number with no base: faster than what, measured how, when, by whom?'));
  }

  // Exclamation marks in running prose.
  for (const { s, line, kind } of sentences) {
    if (kind === 'prose' && /!\s*$/.test(s) && words(s).length >= 3) {
      findings.push(finding('text', 'exclaim', 'low', line, '!', s.slice(0, 160),
        'Exclamation mark in business prose.'));
    }
  }

  // Low-information sentences: no number, no proper noun past the first word, stock vocabulary.
  let lowInfo = 0;
  for (const { s, line, kind } of sentences) {
    if (kind === 'heading' || words(s).length < 8) continue;
    const hasEvidence = EVIDENCE_RE.test(s);
    const rest = s.split(/\s+/).slice(1).join(' ');
    const hasProper = /\b[A-Z][a-zÀ-ɏ]{2,}/.test(rest);
    const stockHits = STOCK_WORDS.filter((w) => new RegExp(`\\b${w}\\b`, 'i').test(s)).length;
    if (!hasEvidence && !hasProper && stockHits >= 1) {
      lowInfo++;
      findings.push(finding('text', 'low-information', 'medium', line, '', s.slice(0, 160),
        'Delete-test candidate: no number, no named thing, and stock vocabulary.'));
    }
  }

  // Repeated sentence openings: the same first two words three times within ten sentences. Spread
  // across a long document, or on citation lines ("Sources: …"), a repeat is not a pattern.
  const openers = new Map();
  sentences.forEach(({ s, line, kind }, at) => {
    if (kind === 'heading') return;
    const ws = words(s);
    if (ws.length < 4 || /[-_./]|[a-z][A-Z]/.test(ws[0]) || /^(?:sources?|data|notes?|caveats?)\s*:/i.test(s.trim())) return;
    const key = ws.slice(0, 2).join(' ').toLowerCase();
    if (key.length < 4) return;
    if (!openers.has(key)) openers.set(key, []);
    openers.get(key).push({ at, line });
  });
  for (const [key, hits] of openers) {
    if (hits.some((h, i) => i + 2 < hits.length && hits[i + 2].at - h.at < 10)) {
      const ls = hits.map((h) => h.line);
      findings.push(finding('text', 'repeated-opening', 'medium', ls[0], key,
        `"${key}..." opens ${ls.length} sentences`, 'Fix the repeated pattern, not the repeated word.',
        { lines: ls }));
    }
  }

  // A contrast with something nobody claimed, split over two sentences or clipped to a tail.
  for (let i = 0; i + 1 < sentences.length; i++) {
    const a = sentences[i];
    const b = sentences[i + 1];
    if (a.kind === 'heading' || b.kind === 'heading') continue;
    if (SPLIT_CONTRAST.some(([first, second]) => first.test(a.s) && second.test(b.s.trim()))) {
      findings.push(finding('text', 'staged-contrast', 'medium', a.line, a.s.trim().slice(0, 80),
        `${a.s.trim()} ${b.s.trim()}`.slice(0, 160),
        'A contrast with something nobody claimed, split over two sentences. State the point.'));
    }
  }
  for (const { s, line, kind } of sentences) {
    const m = kind === 'heading' ? null : s.match(CLIPPED_TAIL);
    if (m) {
      findings.push(finding('text', 'staged-contrast', 'medium', line, m[0].trim(), s.slice(0, 160),
        'A clipped negative tail (", no guessing"). Say what the reader gets instead.'));
    }
  }

  // Writing about the page: weak alone, so it counts as medium only when it repeats.
  const selfHits = sentences.filter(({ s, kind }) => kind !== 'heading' && SELF_RE.test(s));
  for (const { s, line } of selfHits) {
    findings.push(finding('text', 'self-description', selfHits.length >= 2 ? 'medium' : 'low', line,
      (s.match(SELF_RE) || [''])[0], s.slice(0, 160),
      'Writing about the page, not its subject. Keep a source credit, a caveat that changes what the reader does, a convention they cannot see.'));
  }

  // Words split by full stops for emphasis: "Every. Single. Day."
  append(findings, findRegex(prose.filter((l) => l.kind === 'prose'),
    /(?:^|\s)(?:\p{L}{1,12}\.\s+){2,}\p{L}{1,12}\.(?=\s|$)/u, 'period-emphasis', 'medium',
    'Words split by full stops for emphasis. Write the sentence.'));

  /* ---------------------------------------------------------------- metrics */

  const sentLens = sentences.filter((x) => x.kind !== 'heading').map((x) => words(x.s).length).filter((n) => n > 0);
  const meanSent = sentLens.length ? sentLens.reduce((a, b) => a + b, 0) / sentLens.length : 0;
  const sentCV = meanSent ? stdev(sentLens) / meanSent : 0;

  const paras = [];
  let cur = 0;
  for (const l of lines) {
    if (l.kind === 'blank') { if (cur) paras.push(cur); cur = 0; }
    else if (l.kind === 'prose') cur += words(l.text).length;
  }
  if (cur) paras.push(cur);
  const meanPara = paras.length ? paras.reduce((a, b) => a + b, 0) / paras.length : 0;
  const paraCV = meanPara ? stdev(paras) / meanPara : 0;

  const evidenceTokens = (proseText.match(new RegExp(EVIDENCE_RE.source, 'g')) || []).length;
  const count = (rule) => findings.filter((f) => f.rule === rule).length;

  const metrics = {
    words: wc,
    sentences: sentLens.length,
    paragraphs: paras.length,
    headings: prose.filter((l) => l.kind === 'heading').length,
    list_items: count('list-item'),
    latin_share: Math.round(latinShare(proseText) * 100) / 100,
    quoted_spans_skipped: lines.reduce((a, l) => a + (l.quoted_spans || 0), 0),
    mean_sentence_words: Math.round(meanSent * 10) / 10,
    sentence_length_cv: Math.round(sentCV * 100) / 100,
    paragraph_length_cv: Math.round(paraCV * 100) / 100,
    evidence_per_100_words: wc ? Math.round((evidenceTokens / wc) * 10000) / 100 : 0,
    stock_words_per_1000: per1k(count('stock-word')),
    hedges_per_1000: per1k(count('hedge-stack')),
    claim_sentences: claimSentences,
    unsupported_claim_share: claimSentences ? Math.round((unsupported / claimSentences) * 100) / 100 : 0,
    low_information_share: sentLens.length ? Math.round((lowInfo / sentLens.length) * 100) / 100 : 0,
  };

  // Signals, not a verdict: they say where to look first.
  const signals = [];
  if (metrics.words >= 120) {
    if (metrics.sentence_length_cv > 0 && metrics.sentence_length_cv < 0.35)
      signals.push('Sentence length barely varies (CV ' + metrics.sentence_length_cv + '). Human drafts usually run 0.45-0.85.');
    if (metrics.paragraph_length_cv > 0 && metrics.paragraph_length_cv < 0.30 && metrics.paragraphs >= 4)
      signals.push('Every paragraph is nearly the same length (CV ' + metrics.paragraph_length_cv + ').');
    if (metrics.evidence_per_100_words < 0.8)
      signals.push('Under 0.8 evidence tokens per 100 words: few numbers, dates or named things.');
    if (metrics.unsupported_claim_share >= 0.6 && claimSentences >= 3)
      signals.push(Math.round(metrics.unsupported_claim_share * 100) + '% of effect claims carry no number or source.');
    if (metrics.stock_words_per_1000 >= 8)
      signals.push('Stock vocabulary at ' + metrics.stock_words_per_1000 + ' per 1000 words.');
    if (metrics.list_items > 0 && metrics.sentences > 0 && metrics.list_items / metrics.sentences > 0.5)
      signals.push('More list items than prose sentences: check the lists carry ordered or parallel content.');
  }
  if (count('emoji-icon') >= 2) signals.push(`Emoji used as icons ${count('emoji-icon')} times.`);
  if (metrics.latin_share < 0.6)
    signals.push('Mostly non-Latin script (' + metrics.latin_share + ' Latin). The English phrase lists do not apply; see the language notes.');

  return { metrics, signals, findings };
}

/* ================================================================== LOOK LAYER */

const blankOut = (s) => s.replace(/[^\n]/g, ' ');
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);

/**
 * Broken or hostile markup must not stall the scan. A "<" whose next ">" comes after another "<",
 * or never, opens no tag; a comment, script, style or pre after the last place its closer
 * appears never closes. From each such opener the tag and comment patterns would rescan the rest
 * of the input, so its first character becomes a space and no pattern starts there. Linear, and
 * every offset stays where it was.
 */
export function defuse(src) {
  const cut = new Set();
  let close = -2;
  for (let lt = src.indexOf('<'); lt !== -1;) {
    const next = src.indexOf('<', lt + 1);
    if (close !== -1 && close < lt) close = src.indexOf('>', lt + 1);
    if (close === -1 || (next !== -1 && next < close)) cut.add(lt);
    lt = next;
  }
  const lastAt = (re) => {
    let at = -1;
    for (const m of src.matchAll(re)) at = m.index;
    return at;
  };
  for (const [open, shut] of [[/<!--/g, /-->/g], [/\/\*/g, /\*\//g], [/<script\b/gi, /<\/script\b/gi], [/<style\b/gi, /<\/style\b/gi], [/<pre\b/gi, /<\/pre\b/gi]]) {
    const last = lastAt(shut);
    for (const m of src.matchAll(open)) if (m.index > last) cut.add(m.index);
  }
  if (!cut.size) return src;
  let out = '';
  let from = 0;
  for (const at of [...cut].sort((a, b) => a - b)) {
    out += `${src.slice(from, at)} `;
    from = at + 1;
  }
  return out + src.slice(from);
}

/** Blank what is not the author's to judge, keeping every line number intact. */
export function blankIgnored(src) {
  let out = src
    .replace(/<!--\s*slop:ignore-start[\s\S]*?-->[\s\S]*?<!--\s*slop:ignore-end[\s\S]*?-->/gi, blankOut)
    .replace(/\/\*\s*slop:ignore-start[\s\S]*?\*\/[\s\S]*?\/\*\s*slop:ignore-end[\s\S]*?\*\//gi, blankOut);
  const openRe = /<([a-zA-Z][\w-]*)\b[^>]*\bdata-slop-ignore\b[^>]*?(\/?)>/g;
  const ranges = [];
  let m;
  while ((m = openRe.exec(out)) !== null) {
    const tag = m[1].toLowerCase();
    let end = m.index + m[0].length;
    if (!m[2] && !VOID.has(tag)) {
      const tagRe = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'gi');
      tagRe.lastIndex = end;
      let depth = 1;
      let t;
      while (depth > 0 && (t = tagRe.exec(out)) !== null) {
        if (t[1]) depth--;
        else if (!t[0].endsWith('/>')) depth++;
        if (depth === 0) end = t.index + t[0].length;
      }
      if (depth > 0) end = out.length;
    }
    ranges.push([m.index, end]);
    openRe.lastIndex = end;
  }
  for (const [a, b] of ranges.reverse()) out = out.slice(0, a) + blankOut(out.slice(a, b)) + out.slice(b);
  return out;
}

/**
 * Line ranges of elements that depict a product's own words: chat bubbles, terminals,
 * transcripts, consoles. Their text is the product's output, quoted, never the author's prose.
 */
export function depictedRanges(src) {
  const lineOf = lineIndex(src);
  const ranges = [];
  const openRe = /<([a-zA-Z][\w-]*)\b[^>]*\bclass\s*=\s*["']([^"']*)["'][^>]*>/g;
  // Class names only: "shell" and "console" are as often a page wrapper as a terminal.
  const DEPICTED = /^(?:term|tty|messages)$|(?:^|-)(?:chat|terminal|transcript|conversation|bubble|msg)(?:-|$)/i;
  let m;
  while ((m = openRe.exec(src)) !== null) {
    if (!m[2].split(/\s+/).some((c) => DEPICTED.test(c))) continue;
    const tag = m[1].toLowerCase();
    if (VOID.has(tag)) continue;
    const tagRe = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'gi');
    tagRe.lastIndex = m.index + m[0].length;
    let depth = 1;
    let end = src.length;
    let t;
    while (depth > 0 && (t = tagRe.exec(src)) !== null) {
      if (t[1]) depth--;
      else if (!t[0].endsWith('/>')) depth++;
      if (depth === 0) end = t.index + t[0].length;
    }
    // A depicted chat or terminal is a block, not a page; a long range is a wrapper class.
    if (lineOf(end) - lineOf(m.index) <= 300) {
      ranges.push([lineOf(m.index), lineOf(end)]);
      openRe.lastIndex = end;
    }
  }
  return ranges;
}

/* ------------------------------------------------------------------ look: colour */

const NAMED = {
  black: '#000000', white: '#ffffff', red: '#ff0000', orange: '#ffa500', yellow: '#ffff00',
  gold: '#ffd700', lime: '#00ff00', green: '#008000', teal: '#008080', cyan: '#00ffff',
  aqua: '#00ffff', blue: '#0000ff', navy: '#000080', indigo: '#4b0082', purple: '#800080',
  violet: '#ee82ee', magenta: '#ff00ff', fuchsia: '#ff00ff', pink: '#ffc0cb', hotpink: '#ff69b4',
  deeppink: '#ff1493', crimson: '#dc143c', coral: '#ff7f50', tomato: '#ff6347', orchid: '#da70d6',
  plum: '#dda0dd', turquoise: '#40e0d0', royalblue: '#4169e1', dodgerblue: '#1e90ff',
  deepskyblue: '#00bfff', mediumpurple: '#9370db', blueviolet: '#8a2be2', darkviolet: '#9400d3',
};

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return { h: h * 60, s, l };
}

/** Colours written in a CSS value: hex, rgb(), hsl() and common names. var() is unknown. */
export function colorsIn(value) {
  const out = [];
  for (const m of value.matchAll(/#([0-9a-f]{3,8})\b/gi)) {
    let h = m[1];
    if (![3, 4, 6, 8].includes(h.length)) continue;
    if (h.length <= 4) h = h.split('').map((c) => c + c).join('');
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
    const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
    out.push({ raw: m[0], ...rgbToHsl(r, g, b), a });
  }
  for (const m of value.matchAll(/rgba?\(\s*([\d.]+%?)[\s,]+([\d.]+%?)[\s,]+([\d.]+%?)(?:\s*[,/]\s*([\d.]+%?))?\s*\)/gi)) {
    const ch = (v) => (v.endsWith('%') ? (parseFloat(v) * 255) / 100 : parseFloat(v));
    const a = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    out.push({ raw: m[0], ...rgbToHsl(ch(m[1]), ch(m[2]), ch(m[3])), a });
  }
  for (const m of value.matchAll(/hsla?\(\s*([\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%(?:\s*[,/]\s*([\d.]+%?))?\s*\)/gi)) {
    const a = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    out.push({ raw: m[0], h: parseFloat(m[1]), s: parseFloat(m[2]) / 100, l: parseFloat(m[3]) / 100, a });
  }
  for (const m of value.matchAll(/(?<![\w-])([a-z]+)(?![\w-])/gi)) {
    const hex = NAMED[m[1].toLowerCase()];
    if (!hex) continue;
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    out.push({ raw: m[1], ...rgbToHsl(r, g, b), a: 1 });
  }
  return out;
}

const isNeutral = (c) => c.s < 0.15 || c.l < 0.08 || c.l > 0.95 || c.a < 0.08;
const isSaturated = (c) => c.s >= 0.45 && c.l >= 0.2 && c.l <= 0.8 && c.a >= 0.3;
const HUE_NAMES = ['red', 'orange', 'yellow', 'lime', 'green', 'green', 'teal', 'cyan', 'blue', 'indigo', 'violet', 'pink'];
const hueBucket = (h) => Math.floor((((h % 360) + 360 + 15) % 360) / 30);
const isPurplish = (h) => h >= 235 && h <= 340;
const isBluish = (h) => h >= 180 && h < 235;

// Tailwind's default hues, so class-based palettes count the same as CSS ones.
const TW_HUE = {
  red: 0, orange: 25, amber: 38, yellow: 50, lime: 85, green: 142, emerald: 160, teal: 173,
  cyan: 189, sky: 199, blue: 217, indigo: 239, violet: 258, purple: 271, fuchsia: 292, pink: 330, rose: 350,
};

/** A gradient whose stops run violet or indigo into blue, cyan or pink: the stock AI gradient. */
function isAiGradient(hues) {
  const purple = hues.filter(isPurplish);
  if (!purple.length) return false;
  if (hues.some(isBluish)) return true;
  return purple.length >= 2 && Math.max(...purple) - Math.min(...purple) >= 40;
}

/* ------------------------------------------------------------------ look: CSS */

/** Declarations with their selector context and absolute line numbers. */
export function parseCss(css, baseLine = 1) {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, blankOut);
  const lineOf = lineIndex(src);
  const decls = [];
  const keyframes = [];
  const stack = [];
  let start = 0;
  let paren = 0;
  let quote = '';
  const at = (i) => baseLine + lineOf(i) - 1;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === quote && src[i - 1] !== '\\') quote = '';
      continue;
    }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '(') { paren++; continue; }
    if (c === ')') { if (paren) paren--; continue; }
    if (paren) continue;
    if (c === '{') {
      const seg = src.slice(start, i);
      const sel = seg.trim();
      stack.push(sel);
      const kf = sel.match(/^@(?:-webkit-)?keyframes\s+([\w-]+)/i);
      if (kf) keyframes.push({ name: kf[1], line: at(start + Math.max(0, seg.search(/\S/))) });
      start = i + 1;
    } else if (c === ';' || c === '}') {
      const seg = src.slice(start, i);
      const t = seg.trim();
      if (t && stack.length) {
        const colon = t.indexOf(':');
        if (colon > 0 && !t.startsWith('@')) {
          const selector = stack.filter((s) => !s.startsWith('@')).join(' ').replace(/\s+/g, ' ');
          decls.push({
            selector,
            prop: t.slice(0, colon).trim().toLowerCase(),
            value: t.slice(colon + 1).replace(/\s*!important\s*$/i, '').trim(),
            line: at(start + seg.search(/\S/)),
            inKeyframes: stack.some((s) => /^@(?:-webkit-)?keyframes/i.test(s)),
          });
        }
      }
      if (c === '}') stack.pop();
      start = i + 1;
    }
  }
  return { decls, keyframes };
}

const px = (tok) => {
  const m = tok.match(/^(-?\d*\.?\d+)(px|rem|em)?$/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return m[2] === 'rem' || m[2] === 'em' ? n * 16 : n;
};

function splitTop(value) {
  const parts = [];
  let depth = 0;
  let cur = '';
  for (const c of value) {
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (c === ',' && depth === 0) { parts.push(cur); cur = ''; } else cur += c;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

function glowIn(value) {
  for (const shadow of splitTop(value.replace(/drop-shadow\(/g, '('))) {
    const cols = colorsIn(shadow);
    if (!cols.length) continue;
    const lens = shadow.replace(/rgba?\([^)]*\)|hsla?\([^)]*\)|#[0-9a-f]+/gi, ' ')
      .replace(/[()]/g, ' ').split(/\s+/).map(px).filter((n) => n !== null);
    const blur = lens.length >= 3 ? lens[2] : 0;
    if (blur >= 10 && !isNeutral(cols[0]) && cols[0].a >= 0.15) return cols[0].raw;
  }
  return null;
}

const NEUTRAL_VAR = /var\(\s*--[\w-]*(border|line|divider|neutral|muted|gray|grey|separator|outline|stroke|surface|bg)[\w-]*/i;
const DECOR_ANIM = /pulse|glow|shimmer|shine|sheen|float|bounce|sparkle|twinkle|gradient|blob|wave|aurora|beam|marquee|typing|typewriter|wiggle|breathe|orbit|glint|flicker|neon|levitate|hover-?float/i;
const LOADER_ANIM = /spin|load|progress|skeleton|caret|cursor|indeterminate|rotate/i;
const MONO = /mono|code|courier|consolas|menlo|monaco|fira|jetbrains|source code|sf mono|ubuntu mono|inconsolata/i;
const GENERIC_FAMILY = /^(serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-sans-serif|ui-serif|ui-monospace|-apple-system|blinkmacsystemfont|inherit|initial|unset)$/i;

function scanCssDecls(decls, keyframes, push, stats, tokenCount) {
  const capsBySelector = new Map();
  const spacing = new Set();
  const families = new Set();
  const hues = new Map();
  let hardCoded = 0;

  for (const d of decls) {
    const { selector, prop, value, line } = d;
    const where = `${selector || '(inline)'} { ${prop}: ${value.slice(0, 70)} }`;
    if (d.inKeyframes) continue;

    if (prop.startsWith('--')) {
      if (/gradient\(/i.test(value)) push('gradient-token', 'info', line, prop, where, 'A gradient defined as a token. Check where it is used.');
      continue;
    }

    if ((prop === 'background-clip' || prop === '-webkit-background-clip') && /\btext\b/.test(value)
      || (prop === '-webkit-text-fill-color' && /transparent/.test(value))) {
      push('gradient-text', 'high', line, value, where, 'Gradient text. Use the text colour; give one phrase the accent if it must stand out.');
      stats.gradient_text++;
      continue;
    }

    if (/(?:repeating-)?(?:linear|radial|conic)-gradient\(/i.test(value) && !/mask/.test(prop)) {
      const button = /\b(?:btn|button)\b/i.test(selector);
      push('gradient', button ? 'low' : 'medium', line, value.match(/(?:repeating-)?(?:linear|radial|conic)-gradient/i)[0], where,
        button ? 'Gradient on a button. Fine only if it is the design system\'s own.' : 'Decorative gradient. Use a flat surface or the token for this role.');
      stats.gradients++;
      const hs = colorsIn(value).filter(isSaturated).map((c) => c.h);
      if (isAiGradient(hs)) push('ai-gradient', 'medium', line, 'violet-to-blue', where, 'The stock AI gradient: violet or indigo into blue, cyan or pink.');
    }

    if ((prop === 'backdrop-filter' || prop === '-webkit-backdrop-filter') && /blur\(/.test(value)) {
      push('glass', 'medium', line, value, where, 'Glass effect. Use an opaque surface and a 1px border.');
      stats.glass++;
    }

    if (prop === 'box-shadow' || prop === 'text-shadow' || (prop === 'filter' && /drop-shadow/.test(value))) {
      const glow = glowIn(value);
      if (glow) {
        push('glow', 'medium', line, glow, where, 'Coloured glow. Remove it or use the elevation token.');
        stats.glow++;
      }
    }

    if (prop === 'text-transform' && /uppercase/.test(value)) capsBySelector.set(selector, line);
    if (prop === 'letter-spacing' && !/^(0|normal|-)/.test(value)) spacing.add(selector);

    if (/^border-(left|top|inline-start)(-width)?$/.test(prop)) {
      const width = value.split(/\s+/).map(px).find((n) => n !== null);
      const cols = colorsIn(value);
      const coloured = cols.length ? !isNeutral(cols[0]) : /var\(/.test(value) && !NEUTRAL_VAR.test(value);
      if (width >= 3 && (coloured || prop.endsWith('-width')) && !/\b(th|thead|tr|td|hr|table|input|select|textarea)\b/i.test(selector)) {
        const quote = /blockquote/i.test(selector);
        push('accent-rail', quote ? 'low' : 'medium', line, `${prop}: ${value}`, where,
          quote ? 'A rail on a blockquote is ordinary; check it is the only one.' : 'Accent rail or thick top edge. Remove it, or use a 1px neutral border.');
        stats.accent_rails++;
      }
    }

    if ((prop === 'animation' || prop === 'animation-name' || prop === 'animation-iteration-count') && /infinite/.test(value) && !LOADER_ANIM.test(value + selector)) {
      push('endless-motion', 'low', line, value, where, 'An animation that never stops. Motion should mark a change of state.');
    }

    if (prop === 'transform' && /:hover/.test(selector) && /translate(?:Y|3d)?\(\s*(?:0\s*,\s*)?-|scale\(\s*1\.\d/.test(value)) {
      push('hover-lift', 'low', line, value, where, 'Hover lift. Keep hover states for things you can click.');
    }

    if (prop === 'font-family') {
      const first = value.split(',')[0].replace(/["']/g, '').trim();
      if (first && !GENERIC_FAMILY.test(first) && !MONO.test(first) && !/var\(/.test(first)) families.add(first.toLowerCase());
    }

    if (prop === 'height' && /\b(card|tile|box|panel|feature|item)\b/i.test(selector)) {
      const h = px(value);
      if (h !== null && h >= 60) push('fixed-height', 'low', line, value, where, 'Fixed height on a text card. Text may overflow; size from content.');
    }

    if (/^(color|background|background-color|border|border-color|border-[a-z]+-color|fill|stroke|outline-color)$/.test(prop)) {
      for (const c of colorsIn(value)) {
        if (prop !== 'color' || !isNeutral(c)) hardCoded++;
        if (isSaturated(c)) {
          const b = hueBucket(c.h);
          if (!hues.has(b)) hues.set(b, { line, raw: c.raw });
        }
      }
    }
  }

  for (const [selector, line] of capsBySelector) {
    push('caps-label', 'medium', line, 'text-transform: uppercase', `${selector} { text-transform: uppercase${spacing.has(selector) ? '; letter-spacing' : ''} }`,
      'Uppercase label. Fine where the design system puts it (a table header); a tell on eyebrows and labels across the page.');
    stats.caps_labels++;
  }
  for (const k of keyframes) {
    if (DECOR_ANIM.test(k.name) && !LOADER_ANIM.test(k.name)) {
      push('decor-animation', 'medium', k.line, k.name, `@keyframes ${k.name}`, 'Decorative motion. Remove it; keep motion for loading, opening and progress.');
      stats.decor_animations++;
    }
  }
  if (families.size > 2) {
    push('font-mix', 'medium', 1, [...families].join(', '), `font families: ${[...families].join(', ')}`, 'More than two type families. Use one, plus a mono for code.');
  }
  stats.font_families = Math.max(stats.font_families, families.size);
  for (const [b, v] of hues) if (!stats._hues.has(b)) stats._hues.set(b, v);
  if (tokenCount >= 5 && hardCoded >= 3) {
    push('hard-coded-colour', 'info', 1, String(hardCoded), `${hardCoded} hard-coded colours beside ${tokenCount} tokens`, 'Hard-coded colours next to a token system break the other theme.');
  }
  stats.hard_coded_colours += hardCoded;
}

/* ------------------------------------------------------------------ look: classes */

function scanClassList(cls, line, push, stats) {
  const t = cls.split(/\s+/).filter(Boolean).map((c) => c.replace(/^[\w-]+:(?=[\w-])/g, (p) => (p === 'hover:' ? p : '')));
  const has = (re) => t.some((c) => re.test(c));
  const where = `class="${cls.trim().slice(0, 90)}"`;
  if (has(/^bg-clip-text$/) && has(/^text-transparent$/)) {
    push('gradient-text', 'high', line, 'bg-clip-text text-transparent', where, 'Gradient text. Use the text colour; give one phrase the accent if it must stand out.');
    stats.gradient_text++;
  } else if (has(/^bg-(?:gradient-to-|linear-to-|radial|conic)/)) {
    push('gradient', 'medium', line, t.find((c) => /^bg-(?:gradient|linear|radial|conic)/.test(c)), where, 'Decorative gradient. Use a flat surface or the token for this role.');
    stats.gradients++;
  }
  const stops = t.map((c) => c.match(/^(?:from|via|to)-([a-z]+)-\d{2,3}/)).filter(Boolean).map((m) => TW_HUE[m[1]]).filter((h) => h !== undefined);
  if (stops.length >= 2 && isAiGradient(stops)) push('ai-gradient', 'medium', line, 'violet-to-blue', where, 'The stock AI gradient: violet or indigo into blue, cyan or pink.');
  if (has(/^backdrop-blur/)) { push('glass', 'medium', line, 'backdrop-blur', where, 'Glass effect. Use an opaque surface and a 1px border.'); stats.glass++; }
  if (has(/^(?:shadow|drop-shadow)-(?:indigo|violet|purple|fuchsia|pink|blue|cyan|sky|emerald|rose)-\d/) || has(/^(?:shadow|drop-shadow)-\[0_0_/)) {
    push('glow', 'medium', line, 'coloured shadow', where, 'Coloured glow. Remove it or use the elevation token.');
    stats.glow++;
  }
  if (has(/^uppercase$/)) {
    push('caps-label', 'medium', line, has(/^tracking-(?:wide|wider|widest|\[)/) ? 'uppercase tracking' : 'uppercase', where,
      'Uppercase label. Fine where the design system puts it; a tell on eyebrows and labels across the page.');
    stats.caps_labels++;
  }
  if (has(/^border-[lst]-(?:[3-8]|\[\d)/) && has(/^border-(?:[lst]-)?(?:red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d/)) {
    push('accent-rail', 'medium', line, 'border-l', where, 'Accent rail. Remove it, or use a 1px neutral border.');
    stats.accent_rails++;
  }
  if (has(/^animate-(?:pulse|bounce|ping)$/)) { push('decor-animation', 'medium', line, t.find((c) => /^animate-/.test(c)), where, 'Decorative motion. Remove it; keep motion for loading, opening and progress.'); stats.decor_animations++; }
  if (has(/^hover:(?:-translate-y-|scale-1)/)) push('hover-lift', 'low', line, 'hover lift', where, 'Hover lift. Keep hover states for things you can click.');
  if (has(/^blur-(?:2xl|3xl|\[)/) && has(/^(?:absolute|fixed)$/)) push('gradient-blob', 'medium', line, 'blurred blob', where, 'A blurred colour blob behind the content. Use a flat surface.');
  for (const c of t) {
    const m = c.match(/^(?:text|bg|border|fill|stroke|from|via|to)-([a-z]+)-(\d{3})$/);
    if (m && TW_HUE[m[1]] !== undefined && Number(m[2]) >= 300 && Number(m[2]) <= 700) {
      const b = hueBucket(TW_HUE[m[1]]);
      if (!stats._hues.has(b)) stats._hues.set(b, { line, raw: c });
    }
  }
}

/* ------------------------------------------------------------------ look: markup */

const ICON_CONTEXT = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'button', 'a', 'li', 'th', 'label', 'summary', 'dt', 'nav', 'title', 'option']);

function enclosingTag(src, idx) {
  const before = src.slice(Math.max(0, idx - 600), idx);
  const stack = [];
  for (const m of before.matchAll(/<(\/?)(h[1-6]|button|a|li|th|td|label|summary|dt|nav|title|option|p|span|div)\b[^>]*?(\/?)>/gi)) {
    const tag = m[2].toLowerCase();
    if (m[3]) continue;
    if (m[1]) {
      const k = stack.lastIndexOf(tag);
      if (k !== -1) stack.splice(k);
    } else stack.push(tag);
  }
  for (let i = stack.length - 1; i >= 0; i--) if (ICON_CONTEXT.has(stack[i])) return stack[i];
  return stack[stack.length - 1] || '';
}

const ICON_RE = [
  /<i\b[^>]*class\s*=\s*["'][^"']*\b(?:fa[srlbd]?|fa-[\w-]+|bi|bi-[\w-]+|ri-[\w-]+|ti|ti-[\w-]+|lucide|lucide-[\w-]+|icon|icon-[\w-]+|material-icons[\w-]*|material-symbols[\w-]*|ph|ph-[\w-]+|codicon[\w-]*)\b/gi,
  /<span\b[^>]*class\s*=\s*["'][^"']*\bmaterial-(?:icons|symbols)[\w-]*/gi,
  /<[^>]+\bdata-(?:lucide|feather)\s*=/gi,
  /<(?:ion-icon|iconify-icon)\b/gi,
  /<(?:div|span)\b[^>]*class\s*=\s*["'][^"']*\b(?:[\w]+-icon|icon-(?:wrap|wrapper|circle|box|bg|container|badge))\b/gi,
];
const JSX_ICON_RE = /<(?:[A-Z][A-Za-z0-9]*Icon|Sparkles|Rocket|Zap|Lightbulb|ShieldCheck|Shield|BrainCircuit|Brain|Bot|Wand2|Wand|Stars|Star|Target|TrendingUp|Layers|Cpu|Globe|Lock|Cloud|Database|Server|Gauge|Workflow)\b/g;
const HYPE_BADGE = /^(?:new!?|beta|alpha|pilot|blueprint|preview|coming soon|soon|hot|popular|most popular|pro|premium|featured|trending|recommended|best value|limited|exclusive|ai|ai[- ]powered|powered by ai|magic)$/i;
const VAGUE_CTA = /^(?:get started|learn more|explore|discover|read more|click here|unlock[\w\s]*|try (?:it )?(?:now|free|today)|start (?:now|today|for free)|join (?:now|today|us)|sign up (?:now|today)|see more|find out more|let'?s go)[\s!→›»]*$/i;

function scanMarkup(src, kind, push, stats) {
  const lineOf = lineIndex(src);
  const body = src.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, blankOut).replace(/<!--[\s\S]*?-->/g, blankOut);

  // Emoji, judged by the element they sit in.
  for (const m of body.matchAll(EMOJI_SEQ)) {
    const lt = body.lastIndexOf('<', m.index);
    const gt = body.lastIndexOf('>', m.index);
    if (lt > gt) continue; // inside a tag or attribute
    const tag = enclosingTag(body, m.index);
    const line = lineOf(m.index);
    const excerpt = body.slice(Math.max(0, m.index - 60), m.index + 60).replace(/\s+/g, ' ').trim();
    const next = body.indexOf('<', m.index);
    const alone = body.slice(gt + 1, next === -1 ? body.length : next).replace(/\s+/g, '') === m[0];
    const opener = body.slice(Math.max(0, lt), gt + 1);
    if (tag === 'td') {
      push('emoji-data', 'info', line, m[0], excerpt, 'Emoji in a table cell. Fine when it is data, such as a status.');
    } else if (alone || ICON_CONTEXT.has(tag) || /class\s*=\s*["'][^"']*(?:ico|emoji|badge)/i.test(opener)) {
      push('emoji-icon', 'high', line, m[0], excerpt, `Emoji used as an icon in <${tag || 'element'}>. Remove it; the words carry the meaning.`);
      stats.emoji_icons++;
    } else {
      push('emoji', 'medium', line, m[0], excerpt, 'Decorative emoji in running text.');
    }
  }

  // Decorative icon elements.
  const icons = [];
  for (const re of ICON_RE) for (const m of body.matchAll(re)) icons.push(m.index);
  if (kind === 'component') for (const m of body.matchAll(JSX_ICON_RE)) icons.push(m.index);
  const iconLines = [...new Set(icons.map(lineOf))].sort((a, b) => a - b);
  stats.decorative_icons = iconLines.length;
  if (iconLines.length >= 4) {
    for (const line of iconLines) push('decorative-icon', 'medium', line, 'icon', `icon element (${iconLines.length} on the page)`,
      'An icon on every block. Keep icons that carry meaning (status, file type, action); drop the rest.');
  }
  for (const m of body.matchAll(/\bSparkles\b|class\s*=\s*["'][^"']*\b(?:sparkle|magic)[\w-]*/g)) {
    push('ai-sparkle', 'medium', lineOf(m.index), m[0].slice(0, 30), m[0].slice(0, 80), 'Sparkles as the sign for AI. Say what the AI does.');
  }

  // Eyebrows and badges.
  for (const m of body.matchAll(/class\s*=\s*["'][^"']*\b(eyebrow|kicker|overline|pretitle|pre-title|supertitle|super-title|section-label|section-tag|tagline)\b/gi)) {
    push('eyebrow', 'medium', lineOf(m.index), m[1], m[0].slice(0, 90), 'Eyebrow label over a heading. Usually cut; the heading carries it.');
  }
  for (const m of body.matchAll(/<(\w+)\b[^>]*class\s*=\s*["'][^"']*\b(?:badge|pill|tag|chip|ribbon)[\w-]*[^"']*["'][^>]*>([^<]{1,40})</gi)) {
    stats.badges++;
    const text = m[2].replace(/\s+/g, ' ').trim();
    if (HYPE_BADGE.test(text)) push('badge-hype', 'medium', lineOf(m.index), text, m[0].slice(0, 100), 'Hype or status badge. Say status in words where it matters, once.');
  }

  // Calls to action that say nothing about what happens next.
  for (const m of body.matchAll(/<(a|button)\b[^>]*>\s*([^<]{2,40}?)\s*<\/\1>/gi)) {
    const label = m[2].replace(EMOJI_SEQ, '').trim();
    if (VAGUE_CTA.test(label)) push('vague-cta', 'low', lineOf(m.index + m[0].indexOf(m[2])), label, m[0].slice(0, 100), 'Vague call to action. Say what happens: "See the rollout plan".');
  }

  if (kind === 'html' && /<body\b/i.test(body) && !/<h1\b/i.test(body)) {
    push('no-headline', 'low', lineOf(body.search(/<body\b/i)), 'no <h1>', '<body> without an <h1>', 'A page with no headline. Name the page and its claim.');
  }

  const dots = body.match(/#(?:ff5f56|ff5f57|febc2e|ffbd2e|27c93f|28c840)\b/gi) || [];
  if (dots.length >= 2) push('window-dots', 'low', lineOf(body.search(/#(?:ff5f56|ff5f57|febc2e|ffbd2e|27c93f|28c840)\b/i)), 'traffic-light dots', 'macOS window dots', 'Decorative window chrome. A plain block reads better.');
}

/** The look layer for HTML, CSS and component files. */
export function scanLook(src, kind) {
  const findings = [];
  const stats = {
    style_blocks: 0, css_declarations: 0, gradients: 0, gradient_text: 0, glass: 0, glow: 0,
    caps_labels: 0, accent_rails: 0, emoji_icons: 0, decorative_icons: 0, badges: 0,
    decor_animations: 0, saturated_hues: 0, font_families: 0, hard_coded_colours: 0, _hues: new Map(),
  };
  const push = (rule, severity, line, match, excerpt, note) => findings.push(finding('look', rule, severity, line, match, excerpt, note));
  const lineOf = lineIndex(src);

  const sheets = [];
  if (kind === 'css') sheets.push({ css: src, line: 1 });
  else {
    for (const m of src.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) {
      sheets.push({ css: m[1], line: lineOf(m.index + m[0].indexOf('>') + 1) });
      stats.style_blocks++;
    }
    if (kind === 'component') {
      for (const m of src.matchAll(/(?:styled(?:\.[a-zA-Z]+|\([^)]*\))(?:\.attrs\([^)]*\))?|\bcss|createGlobalStyle|\bkeyframes)\s*`([\s\S]*?)`/g)) {
        sheets.push({ css: m[1].replace(/\$\{[^}]*\}/g, (x) => blankOut(x)), line: lineOf(m.index) });
      }
    }
  }

  const all = [];
  const frames = [];
  for (const s of sheets) {
    const { decls, keyframes } = parseCss(s.css, s.line);
    append(all, decls);
    append(frames, keyframes);
  }
  for (const m of src.matchAll(/\bstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
    const css = m[1] ?? m[2];
    for (const d of parseCss(`x{${css}}`, lineOf(m.index)).decls) all.push({ ...d, selector: '(inline style)' });
  }
  if (kind === 'component') {
    for (const m of src.matchAll(/\bstyle=\{\{([\s\S]*?)\}\}/g)) {
      const line = lineOf(m.index);
      for (const p of m[1].matchAll(/([a-zA-Z]+)\s*:\s*(['"`])([\s\S]*?)\2/g)) {
        all.push({ selector: '(inline style)', prop: p[1].replace(/[A-Z]/g, (c) => '-' + c.toLowerCase()), value: p[3], line, inKeyframes: false });
      }
    }
  }
  stats.css_declarations = all.length;
  const tokenCount = all.filter((d) => d.prop.startsWith('--') && colorsIn(d.value).length).length;
  scanCssDecls(all, frames, push, stats, tokenCount);

  if (kind !== 'css') {
    for (const m of src.matchAll(/(?:\bclass|\bclassName)\s*=\s*(?:"([^"]*)"|'([^']*)'|\{\s*["'`]([^"'`]*)["'`]\s*\})/g)) {
      scanClassList(m[1] ?? m[2] ?? m[3] ?? '', lineOf(m.index), push, stats);
    }
    scanMarkup(src, kind, push, stats);
  }

  stats.saturated_hues = stats._hues.size;
  if (stats._hues.size >= 6) {
    const first = Math.min(...[...stats._hues.values()].map((v) => v.line));
    const names = [...new Set([...stats._hues.keys()].sort((a, b) => a - b).map((b) => HUE_NAMES[b]))];
    push('rainbow-palette', 'medium', first, `${stats._hues.size} hues`, `saturated colours in ${names.join(', ')}`,
      'A rainbow palette. One muted colour per category that means something; everything else neutral.');
  }
  delete stats._hues;

  const signals = [];
  if (stats.gradients >= 3) signals.push(`${stats.gradients} gradients outside tokens: gradients used as decoration.`);
  if (stats.gradient_text) signals.push(`Gradient text on ${stats.gradient_text} rules.`);
  if (stats.glass + stats.glow >= 2) signals.push(`Glass or glow on ${stats.glass + stats.glow} rules.`);
  if (stats.caps_labels >= 3) signals.push(`Uppercase labels on ${stats.caps_labels} selectors or elements.`);
  if (stats.emoji_icons >= 2) signals.push(`Emoji used as icons ${stats.emoji_icons} times.`);
  if (stats.decorative_icons >= 4) signals.push(`${stats.decorative_icons} icon elements: an icon on every block.`);
  if (stats.accent_rails >= 2) signals.push(`Accent rails on ${stats.accent_rails} rules.`);
  if (stats.saturated_hues >= 6) signals.push(`${stats.saturated_hues} saturated hues: a rainbow palette.`);
  if (stats.font_families > 2) signals.push(`${stats.font_families} type families.`);
  if (stats.decor_animations) signals.push(`${stats.decor_animations} decorative animations.`);

  return { metrics: stats, signals, findings };
}

/* ================================================================== SCAN */

export function detectKind(input, file = '', forced = '') {
  if (forced) return forced;
  const ext = extname(file || '').toLowerCase();
  if (['.html', '.htm', '.xhtml'].includes(ext)) return 'html';
  if (['.css', '.scss', '.sass', '.less'].includes(ext)) return 'css';
  if (['.jsx', '.tsx', '.vue', '.svelte', '.astro'].includes(ext)) return 'component';
  if (ext === '.json') return 'json';
  if (['.md', '.markdown', '.mdx', '.txt', '.rst', '.adoc'].includes(ext)) return 'text';
  const head = input.slice(0, 8000);
  const tagHits = (head.match(
    /<\/?(?:html|head|body|div|section|article|header|footer|nav|main|aside|p|h[1-6]|ul|ol|li|table|tr|td|th|span|strong|em|b|i|a|button|form|input|label|script|style)\b/gi,
  ) || []).length;
  if (/<!doctype html|<html\b/i.test(head.slice(0, 1000)) || tagHits >= 5) return 'html';
  if (/^\s*[\[{]/.test(head)) {
    try { JSON.parse(input); return 'json'; } catch { /* not JSON */ }
  }
  if (/^\s*(?:@import|:root|[.#]?[\w-]+(?:\s*[,>+~]\s*[\w.#-]+)*\s*\{[^}]*:[^}]*;)/m.test(head) && !/[.!?]\s+[A-Z]/.test(head.replace(/\/\*[\s\S]*?\*\//g, ''))) return 'css';
  return 'text';
}

const ORDER = { high: 0, medium: 1, low: 2, info: 3 };

export function scan(input, opts = {}) {
  const kind = detectKind(input, opts.file, opts.kind);
  const src = blankIgnored(defuse(input));
  const empty = { metrics: {}, signals: [], findings: [] };

  let text = empty;
  if (!opts.lookOnly && kind !== 'css') {
    let prepared = { text: src, map: null };
    if (kind === 'html') prepared = htmlToTextMapped(src);
    else if (kind === 'json') prepared = jsonToTextMapped(src) || prepared;
    else if (kind === 'component') prepared = componentToTextMapped(src);
    text = scanText(prepared.text, { emoji: kind !== 'html' && kind !== 'component' });
    if (prepared.map) {
      const at = (n) => prepared.map[n - 1] ?? n;
      for (const f of text.findings) {
        f.line = at(f.line);
        if (f.lines) f.lines = f.lines.map(at);
      }
    }
    for (const f of text.findings) {
      if (f.rule === 'repeated-opening') f.excerpt += ` (lines ${f.lines.slice(0, 6).join(', ')})`;
      delete f.lines;
    }
  }

  let look = empty;
  if (!opts.textOnly && ['html', 'css', 'component'].includes(kind)) look = scanLook(src, kind);

  // Quoted material is never edited, so a finding inside a quote is never actionable. A depicted
  // chat or terminal counts as quoted: it shows what a product said, not what the author wrote.
  const findings = [...text.findings, ...look.findings];
  if (kind === 'html' || kind === 'component') {
    const depicted = depictedRanges(src);
    for (const f of findings) if (depicted.some(([a, b]) => f.line >= a && f.line <= b)) f.in_quote = true;
  }
  for (const f of findings) {
    if (f.in_quote && f.severity !== 'info') {
      f.severity = 'info';
      f.note += ' (quoted: reported, not actionable)';
    }
  }

  const listed = findings
    .filter((f) => f.rule !== 'list-item')
    .sort((a, b) => a.line - b.line || a.layer.localeCompare(b.layer) || a.rule.localeCompare(b.rule));
  const byRule = {};
  const bySeverity = { high: 0, medium: 0, low: 0, info: 0 };
  for (const f of listed) {
    byRule[f.rule] = (byRule[f.rule] || 0) + 1;
    bySeverity[f.severity]++;
  }

  return {
    input_kind: kind,
    metrics: { text: text.metrics, look: look.metrics },
    signals: [...text.signals, ...look.signals],
    findings: listed,
    summary: { by_rule: byRule, by_severity: bySeverity, total: listed.length },
  };
}

/** Actionable findings at or above a severity, optionally in one layer: the gate behind --fail-on and --fail-on-look. */
export function countAtOrAbove(result, level, layer = '') {
  const max = ORDER[level] ?? ORDER.high;
  return result.findings.filter((f) => f.severity !== 'info' && ORDER[f.severity] <= max && (!layer || f.layer === layer)).length;
}

/* ------------------------------------------------------------------ reporting */

// The default report is short on purpose: an agent reads it, and every line costs tokens.
// One line of metrics per layer, three examples per high or medium rule plus the remaining line
// numbers, and low and info findings as one line each. --full prints everything.
function report(r, file, full = false) {
  const L = [`slop scan: ${file} (${r.input_kind})`];
  const t = r.metrics.text || {};
  const k = r.metrics.look || {};
  for (const [layer, m] of [['text', t], ['look', k]]) {
    if (!Object.keys(m).length) continue;
    if (full) {
      L.push('', `${layer.toUpperCase()} METRICS`);
      for (const [key, v] of Object.entries(m)) L.push(`  ${key.padEnd(26)} ${v}`);
    } else if (layer === 'text') {
      L.push(`text: ${m.words} words; sentence length CV ${m.sentence_length_cv}; evidence ${m.evidence_per_100_words} per 100 words; stock words ${m.stock_words_per_1000} per 1000; unsupported claims ${Math.round(m.unsupported_claim_share * 100)}% of ${m.claim_sentences}`);
    } else {
      L.push(`look: ${m.css_declarations} CSS declarations; gradients ${m.gradients}, gradient text ${m.gradient_text}, glass ${m.glass}, glow ${m.glow}, uppercase labels ${m.caps_labels}, emoji icons ${m.emoji_icons}, icon elements ${m.decorative_icons}, saturated hues ${m.saturated_hues}`);
    }
  }
  if (r.signals.length) {
    L.push('', 'SIGNALS (where to look first, not a verdict)');
    for (const s of r.signals) L.push('  - ' + s);
  }
  const quiet = [];
  for (const layer of ['text', 'look']) {
    if (!r.metrics[layer] || !Object.keys(r.metrics[layer]).length) continue;
    const groups = {};
    for (const f of r.findings.filter((x) => x.layer === layer)) (groups[f.rule] ||= []).push(f);
    const rules = Object.keys(groups).sort(
      (a, b) => ORDER[groups[a][0].severity] - ORDER[groups[b][0].severity] || groups[b].length - groups[a].length,
    );
    L.push('', `FINDINGS: ${layer.toUpperCase()}`);
    if (!rules.length) L.push('  none');
    // A long, noisy input still gets a short report: fewer examples when many rules fire.
    const loud = rules.filter((x) => !['low', 'info'].includes(groups[x][0].severity)).length;
    const perRule = (sev) => (loud > 15 ? (sev === 'high' ? 2 : 1) : 3);
    for (const rule of rules) {
      const g = groups[rule];
      const sev = g[0].severity;
      if (!full && (sev === 'low' || sev === 'info')) {
        quiet.push(`${sev}: ${rule} x${g.length} (L${g.slice(0, 5).map((f) => f.line).join(', L')}${g.length > 5 ? ', …' : ''})`);
        continue;
      }
      const shown = full ? g : g.slice(0, perRule(sev));
      L.push(`  [${sev}] ${rule} x${g.length}  ${g[0].note}`);
      for (const f of shown) L.push(`      L${f.line}${f.in_quote ? ' (quoted, do not edit)' : ''}: ${full ? f.excerpt : f.excerpt.slice(0, 110)}`);
      if (g.length > shown.length) {
        const rest = [...new Set(g.slice(shown.length).map((f) => f.line))];
        L.push(`      + ${g.length - shown.length} more: L${rest.slice(0, 15).join(', L')}${rest.length > 15 ? ', …' : ''}`);
      }
    }
  }
  if (quiet.length) L.push('', 'LOW AND INFO (census; often fine)', ...quiet.map((q) => '  ' + q));
  const s = r.summary.by_severity;
  L.push('', `TOTAL  high ${s.high}  medium ${s.medium}  low ${s.low}  info ${s.info}`);
  return L.join('\n');
}

/* ------------------------------------------------------------------ self-test */

function selfTest() {
  const t = [];
  const ok = (name, cond, extra = '') => t.push({ name, pass: !!cond, extra });
  const rules = (input, opts) => scan(input, opts).summary.by_rule;

  // Text layer: carried over from the humanizer scanner.
  ok('code fences are not scanned', rules(['Text before.', '```js', 'const seamless = "delve";', '```', 'Text after.'].join('\n'))['stock-word'] === undefined);
  ok('front matter is not scanned', rules(['---', 'title: Leveraging Seamless Synergy', '---', 'Plain body text here.'].join('\n'))['stock-word'] === undefined);
  const qr = scan(['> Our robust platform delivers seamless synergy.', '', 'My own sentence.'].join('\n'));
  ok('quoted lines are marked, never silently edited', qr.findings.filter((f) => f.rule === 'stock-word').every((f) => f.in_quote === true));
  ok('bold-label lists are caught', rules('- **Performance:** it got faster\n- **Security:** it got safer')['bold-label-list'] === 2);
  const dr = rules('- **`src/api/`** — request handlers\n- **`bin/deploy`** — the release script');
  ok('bold path labels are a definition list, not a tell', dr['bold-label-list'] === undefined && dr['definition-list'] === 2);
  ok('table rows are not rhetorical triples', rules('| a, b, and c | d |')['rule-of-three'] === undefined);
  ok('arrows and check marks are not emoji', rules('Stage one → stage two ✓ done.')['emoji'] === undefined);
  ok('unsupported claim is caught', rules('The migration significantly improved throughput.')['unsupported-claim'] === 1);
  ok('a claim with numbers is not flagged', rules('The migration cut p99 latency from 840 ms to 210 ms.')['unsupported-claim'] === undefined);
  ok('URLs are masked', rules('See https://example.com/delve-into-seamless-synergy for details.')['stock-word'] === undefined);
  ok('inline code is masked', rules('Call `leverage_seamless()` before the run.')['stock-word'] === undefined);
  ok('a finding inside a quote is never actionable', scan('> Our robust platform delivers seamless synergy, showcasing our commitment.').findings.every((f) => f.severity === 'info'));
  ok('a bare degree adjective is a description, not a claim', rules('End on the least dramatic sentence, where the information ran out.')['unsupported-claim'] === undefined);
  ok('a degree adjective on an effect noun is still a claim', rules('The rollout produced a significant reduction across every region.')['unsupported-claim'] === 1);
  ok('an imperative is not a claim of effect', rules('If the honest answer is four sentences, deliver four sentences.')['unsupported-claim'] === undefined);
  ok('a bare comparative is not a claim of effect', rules('Being explicit about the assumption is better than being right silently.')['unsupported-claim'] === undefined);
  ok('a modal claim of effect is still caught', rules('The rollout will reduce infrastructure costs across every region.')['unsupported-claim'] === 1);
  const qq = scan('Cut phrases such as "significantly improved outcomes" and "experts agree" from the draft.');
  ok('text inside quotation marks is discussed, not scanned', qq.summary.by_rule['unsupported-claim'] === undefined && qq.summary.by_rule['vague-source'] === undefined && qq.metrics.text.quoted_spans_skipped === 2);
  ok('bold that runs into the sentence is emphasis, not a mini-heading', rules('1. **Classify the artifact** and load its profile from the reference.')['bold-label-list'] === undefined);
  ok('hedge stacking is caught', (rules('This could potentially maybe help in most cases.')['hedge-stack'] || 0) >= 1);
  ok('a run of the same opening is a pattern', rules('The team moved the queue to Kafka. The team added three consumers on Monday. The team cut the backlog to zero.')['repeated-opening'] === 1);
  const spread = Array.from({ length: 24 }, (_, i) => `Word${i} stands alone on this line.`);
  [0, 12, 23].forEach((i) => { spread[i] = `The team changed setting number ${i}.`; });
  ok('the same opening spread through a long text is not', rules(spread.join(' '))['repeated-opening'] === undefined);
  ok('citation lines are not a pattern', rules('Sources: pilot logs, September 2026. Sources: CI export, August 2026. Sources: the survey of 18 teams.')['repeated-opening'] === undefined);
  ok('"as often as" and "rather than" are not hedges', rules('People may review as often as the team needs, rather than at a fixed gate.')['hedge-stack'] === undefined);
  const hr = scan('<html><body><h1>Vibrant Robust Platform</h1><p>We leverage seamless synergy.</p></body></html>');
  ok('html is converted before scanning', hr.input_kind === 'html' && (hr.summary.by_rule['stock-word'] || 0) >= 2);
  ok('bold labels survive the html conversion', rules('<ul><li><strong>Scalability:</strong> it scales.</li><li><strong>Security:</strong> it is safe.</li></ul>')['bold-label-list'] === 2);
  ok('markdown with a stray inline tag is not treated as html', scan('# Title\n\nA line.<br>\n\n<img src="x.png">\n\nAnother line of body copy.').input_kind === 'text');
  ok('html headings are recognised as headings', (rules('<body><h2>Key Takeaways</h2><p>Some body text goes here for length.</p></body>')['stock-heading'] || 0) === 1);
  ok('script bodies never reach the scan', rules('<body><p>Plain body copy here.</p><script>var x = "delve tapestry";</script></body>')['stock-word'] === undefined);
  const notes = scan(['<body>', '<section class="slide" data-section="Pilot"', '  data-notes="Say that we leverage seamless tooling.">', '  <h2>Three teams kept 812 of 1,140 tests</h2>', '</section>', '</body>'].join('\n'));
  ok('speaker notes are scanned at their line', notes.summary.by_rule['stock-word'] === 2 && notes.findings.filter((f) => f.rule === 'stock-word').every((f) => f.line === 3));
  ok('non-Latin script raises a language signal', scan('Це речення українською мовою, без жодного англійського слова тут.').signals.some((s) => s.includes('non-Latin')));
  const clean = [
    'We moved billing off the shared Postgres box on 14 March.',
    'It had been carrying 2.4 TB and four unrelated services.',
    'Checkout p99 went from 840 ms to 210 ms; the write path is unchanged.',
    'The migration cost us a weekend and one rolled-back attempt on 12 March.',
  ].join(' ');
  const cr = scan(clean);
  ok('concrete human prose produces no high-severity findings', cr.findings.filter((f) => f.severity === 'high').length === 0, JSON.stringify(cr.findings.filter((f) => f.severity === 'high')));
  ok('empty input does not throw', scan('').metrics.text.words === 0);
  ok('table rows do not crash the sentence splitter', scan('| a | b |\n| - | - |\n| 1 | 2 |').metrics.text.words >= 0);

  // Text layer: additions beyond the first humanizer scanner.
  ok('a multiplier with no base is caught', rules('Teams ship 10x faster with the new pipeline.')['number-no-base'] === 1);
  ok('a multiplier with its base is not', rules('Agentic runs used about 1000x more tokens than code chat.')['number-no-base'] === undefined);
  ok('a stat alone on its line is a bare stat', rules('<div class="stat"><div class="v">10x</div>\n<div class="l">Faster releases</div></div>')['bare-stat'] === 1);
  ok('typed capitals are caught', rules('TOTAL USERS: 10,761 this week.')['caps-text'] === 1);
  ok('acronyms are not shouted labels', rules('Deploy to AWS EKS through the CI API.')['caps-text'] === undefined);
  ok('figurative verbs are caught', rules('Context travels with every session.')['figurative'] === 1);
  ok('hooks are caught', rules('The result? Nobody waits for staging any more.')['hook'] === 1);
  ok('index points are caught', rules('Today = 100; the new flow costs 45.')['index-points'] === 1);
  ok('an alliterative triad is caught', rules('Our method has three phases: Assess, Align, Accelerate.')['alliterative'] === 1);
  ok('a literal effect verb is a description, not a claim',
    rules('A real browser drives the feature. A task to deliver. The things you found to improve.')['unsupported-claim'] === undefined);
  ok('an effect verb acting on a benefit is a claim',
    rules('The new flow cuts review time for every team.')['unsupported-claim'] === 1 && rules('Developer productivity increased across the board.')['unsupported-claim'] === 1);
  const glossary = Array.from({ length: 9 }, (_, i) => `- **Term Number${String.fromCharCode(65 + i)}**: The meaning of term ${i}.`).join('\n');
  ok('a long run of bold terms is a glossary', rules(glossary)['bold-label-list'] === undefined && rules(glossary)['definition-list'] === 9);
  ok('social proof needs a crowd, not a literal "trusted by"',
    rules('Work that has to be trusted by someone else.')['social-proof'] === undefined && rules('Trusted by 500+ teams worldwide.')['social-proof'] >= 1);
  const chat = scan('<html><body><h1>Run</h1>\n<div class="chat-msg assistant">\nWould you like me to create a ticket?\n</div>\n<p>Would you like me to file it?</p></body></html>');
  ok('words inside a depicted chat or terminal are quoted, not the author\'s',
    chat.findings.filter((f) => f.rule === 'chatbot-artifact').map((f) => f.severity).join() === 'info,high');
  ok('file names in capitals are not shouted labels', rules('See docs/ANALYTICS-REPORT.md for the commands.')['caps-text'] === undefined);
  ok('an emoji alone in an element is an icon', rules('<html><body><h1>T</h1><div class="co-i">⚠</div><p>Text.</p></body></html>')['emoji-icon'] === 1);
  const gl = scan('Our background agents and the LLM-as-a-judge run nightly. The Flywheel keeps it going. We counted story points.');
  ok('glossary words are caught with their replacement',
    gl.summary.by_rule['glossary'] === 2 && gl.summary.by_rule['internal-name'] === 1 && gl.summary.by_rule['glossary-context'] === 1
    && gl.findings.some((f) => f.rule === 'glossary' && f.excerpt.includes('headless agent')));
  const comp = scan('const items = [\n  {\n    description:\n      \'Supercharge your CI with seamless caching.\',\n  },\n];\n<button>\n  Get Started 🚀\n</button>', { file: 'X.tsx' });
  ok('component text is reported on its own line, and an emoji does not hide a vague call to action',
    comp.findings.find((f) => f.rule === 'stock-word')?.line === 4 && comp.summary.by_rule['vague-cta'] === 1);
  ok('product names are not an alliterative triad',
    rules('It works in Claude Code, Codex, Cursor and GitHub Copilot.')['alliterative'] === undefined && rules('Three phases: Assess, Align, Accelerate.')['alliterative'] === 1);
  ok('a price per unit is flagged, a total spend is not',
    rules('Pricing is simple: $1,200 per story point.')['price'] === 1 && rules('September spend was $2,140 across six teams.')['price'] === undefined);
  const big = report(scan(readFileSync(new URL(import.meta.url), 'utf8').replace(/[\s\S]*?\/\/ Individually harmless/, ''), { file: 'x.txt' }), 'x.txt');
  ok('the default report stays short on a long, noisy input', big.split('\n').length < 120, `${big.split('\n').length} lines`);
  ok('a glossary word inside code is not a finding', rules('Set `background_agent: true` in the config.')['glossary'] === undefined);
  const md = scan('## 🚀 Launch plan\n\n- ✅ Done\n\nShipped on time 🎉 with no rollbacks.');
  ok('emoji on a heading or bullet is an icon, inline emoji is decoration', md.summary.by_rule['emoji-icon'] === 2 && md.summary.by_rule['emoji'] === 1);

  // Newer patterns (blader's humanizer, v3.1.0).
  ok('a contrast split over two sentences is caught',
    rules('This does not mean every choice is equal. It means no system confirms which one is right.')['staged-contrast'] === 1);
  ok('a clipped negative tail is caught', rules('The options come from the selected item, no guessing.')['staged-contrast'] === 1);
  ok('a plain negation is not a staged contrast',
    rules('The gateway does not mean to replace the proxy, and the proxy stays. Its logs are kept for a week.')['staged-contrast'] === undefined);
  ok('an answer to an objection nobody raised is caught', rules("To be clear, this isn't about replacing engineers.")['phantom-objection'] === 2);
  ok('an objection the text names and answers is not flagged',
    rules('The security team asked whether the agent can read secrets. It cannot: the sandbox holds none.')['phantom-objection'] === undefined);
  const selfScan = scan('The table below compares the options. This report was generated from the tracker.');
  ok('writing about the page is caught, and counts more when it repeats',
    rules('The table below compares the three options.')['self-description'] === 1 &&
    scan('The table below compares the three options.').findings.find((f) => f.rule === 'self-description').severity === 'low' &&
    selfScan.findings.filter((f) => f.rule === 'self-description').every((f) => f.severity === 'medium'));
  ok('a source credit is not writing about the page', rules('Source: CodeMie analytics export, 13 October 2026.')['self-description'] === undefined);
  ok('words split by full stops are caught', rules('We ship it. Every. Single. Day.')['period-emphasis'] === 1);
  ok('abbreviations are not split emphasis', rules('Use e.g. the default, i.e. the light theme.')['period-emphasis'] === undefined);
  ok('a send-off is inflated significance', rules('The future looks bright for the platform team.')['inflated-significance'] === 1);
  ok('a closer that names what an example showed is a hook',
    rules('Two teams shipped in a week. This shows the importance of good tooling.')['hook'] === 1);
  ok('a knowledge-limit disclaimer is caught', rules('While specific details are limited, the founder likely studied in Kyiv.')['knowledge-limit'] === 1);
  ok('a list of outlets is social proof', rules('As featured in Forbes, TechCrunch and Wired.')['social-proof'] === 1);
  ok('newer stock words count', rules('The release bolstered an enduring and valuable platform.')['stock-word'] === 3);
  ok('"Additionally," and "functions as a" are filler', rules('Additionally, the cache functions as a buffer.')['filler'] === 2);
  ok('a staged run-up is fake depth', rules('The thing is, nobody measured the latency.')['fake-depth'] === 1);
  ok('a staged transition is an announcement', rules("Now let's look at the numbers for September.")['announce'] === 1);

  // Line mapping.
  const mapped = scan(['<html>', '<body>', '<main>', '  <p>Plain intro.</p>', '  <h2>Key Takeaways</h2>', '</main>', '</body>', '</html>'].join('\n'));
  ok('html findings carry their source line', mapped.findings.find((f) => f.rule === 'stock-heading')?.line === 5);
  const json = scan('{\n  "id": "seamless-robust-thing",\n  "title": "Unlock seamless delivery for every team",\n  "icon": "rocket"\n}', { file: 'page.json' });
  ok('json prose values are scanned at their line, keys and ids are not', json.input_kind === 'json' && json.findings.filter((f) => f.rule === 'stock-word').every((f) => f.line === 3) && json.summary.by_rule['stock-word'] === 2);

  // Look layer.
  const css = (body) => scan(body, { file: 'x.css' }).summary.by_rule;
  ok('gradient text is high', scan('.hero h1 { background: linear-gradient(90deg,#8b5cf6,#3b82f6); -webkit-background-clip: text; background-clip: text; }', { file: 'x.css' }).findings.some((f) => f.rule === 'gradient-text' && f.severity === 'high'));
  ok('the stock AI gradient is named', css('.hero { background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 50%, #ec4899 100%); }')['ai-gradient'] === 1);
  ok('a mask gradient is not decoration', css('.fade { mask-image: linear-gradient(90deg, #000 85%, transparent); }')['gradient'] === undefined);
  ok('a gradient token is census only', css(':root { --brand: linear-gradient(90deg, #672D92, #547CCC); }')['gradient-token'] === 1);
  ok('glass is caught', css('.card { backdrop-filter: blur(12px); background: rgba(255,255,255,.08); }')['glass'] === 1);
  ok('a coloured glow is caught', css('.card { box-shadow: 0 0 40px rgba(139, 92, 246, 0.45); }')['glow'] === 1);
  ok('a neutral elevation shadow is not a glow', css('.card { box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3); }')['glow'] === undefined);
  ok('uppercase labels are caught once per selector', css('.eyebrow { text-transform: uppercase; letter-spacing: .2em; }')['caps-label'] === 1);
  ok('an accent rail is caught', css('.card { border-left: 4px solid #8b5cf6; }')['accent-rail'] === 1);
  ok('a neutral 1px border is not a rail', css('.card { border-left: 1px solid #e5e5e5; }')['accent-rail'] === undefined);
  ok('decorative keyframes are caught, spinners are not', css('@keyframes pulse-glow { 0% { opacity: .5 } } @keyframes spin { to { transform: rotate(1turn) } }')['decor-animation'] === 1);
  const rainbow = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#06b6d4', '#3b82f6', '#a855f7'].map((c, i) => `.c${i} { color: ${c}; }`).join('\n');
  ok('six or more saturated hues is a rainbow', css(rainbow)['rainbow-palette'] === 1);
  ok('two hues is not a rainbow', css('.a { color: #2563eb; } .b { color: #16a34a; }')['rainbow-palette'] === undefined);
  const tw = scan('<h1 class="text-5xl font-bold bg-gradient-to-r from-purple-500 to-blue-500 bg-clip-text text-transparent">Hi</h1>\n<p class="uppercase tracking-widest text-xs">Overview</p>', { file: 'Hero.tsx' }).summary.by_rule;
  ok('tailwind gradient text, AI gradient and uppercase labels are caught', tw['gradient-text'] === 1 && tw['ai-gradient'] === 1 && tw['caps-label'] === 1);
  const em = scan('<html><body><h2>🚀 Fast</h2><table><tr><td>✅</td></tr></table><p>Ready 🎉 now.</p></body></html>');
  ok('emoji are judged by their element', em.summary.by_rule['emoji-icon'] === 1 && em.summary.by_rule['emoji-data'] === 1 && em.summary.by_rule['emoji'] === 1);
  const ignored = scan('<html><head><style data-slop-ignore>.x{background:linear-gradient(#a855f7,#3b82f6);text-transform:uppercase}</style><style>/* slop:ignore-start */ .y{backdrop-filter:blur(8px)} /* slop:ignore-end */ .z{color:#111}</style></head><body><h1>Title</h1></body></html>');
  ok('ignored elements and regions are not scanned', ignored.findings.filter((f) => f.layer === 'look').length === 0, JSON.stringify(ignored.findings.filter((f) => f.layer === 'look')));
  const cleanCss = ':root { --text: #1a1a1a; --muted: #6b6b6b; --border: #e5e5e5; --surface: #ffffff; --accent: #3f6fae; }\nh1 { font-weight: 600; color: var(--text); }\n.card { border: 1px solid var(--border); background: var(--surface); }\n.label { color: var(--muted); font-size: 12px; }';
  ok('a token-based stylesheet raises nothing above low', scan(cleanCss, { file: 'x.css' }).findings.filter((f) => ['high', 'medium'].includes(f.severity)).length === 0);
  ok('vague calls to action are caught', rules('<html><body><h1>T</h1><a href="#">Learn more</a> <button>Book a review</button></body></html>')['vague-cta'] === 1);
  ok('fail-on counts actionable findings only', countAtOrAbove(scan('<html><body><h2>🚀 Fast</h2></body></html>'), 'high') === 1 && countAtOrAbove(scan('Plain words on 3 May.'), 'medium') === 0);
  const glass = scan('<html><head><style>.card{backdrop-filter:blur(8px)}</style></head><body><h1>Title</h1><p>It significantly improves productivity.</p></body></html>');
  ok('fail-on-look counts the look layer only', countAtOrAbove(glass, 'medium', 'look') === 1 && countAtOrAbove(glass, 'high', 'look') === 0 && countAtOrAbove(glass, 'high') === 1);

  const passed = t.filter((x) => x.pass).length;
  for (const x of t) if (!x.pass) console.error(`FAIL  ${x.name} ${x.extra}`);
  console.log(`${passed}/${t.length} self-tests passed`);
  return passed === t.length ? 0 : 1;
}

/* ------------------------------------------------------------------ cli */

function main(argv) {
  const args = argv.slice(2);
  if (args.includes('--self-test')) return selfTest();
  if (!args.length || args.includes('-h') || args.includes('--help')) {
    console.log('usage: slop-scan.mjs <file> [--full | --json] [--text-only | --look-only] [--fail-on high|medium|low] [--fail-on-look high|medium|low]\n       slop-scan.mjs --stdin [--html | --css | --md] ...\n       slop-scan.mjs --self-test');
    return args.length ? 0 : 1;
  }

  const json = args.includes('--json');
  const useStdin = args.includes('--stdin');
  const valueOf = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : '');
  const failOn = valueOf('--fail-on');
  const failOnLook = valueOf('--fail-on-look');
  const forced = args.includes('--html') ? 'html' : args.includes('--css') ? 'css' : args.includes('--md') ? 'text' : '';
  const file = useStdin ? '<stdin>' : args.find((a, i) => !a.startsWith('--') && !['--fail-on', '--fail-on-look'].includes(args[i - 1]));

  if (/\.(docx|pptx|xlsx|pdf|odt|key|pages)$/i.test(file || '')) {
    console.error(`${file} is a binary document. Extract its text first (pandoc, python-docx, python-pptx or a PDF text tool), then scan the extract.`);
    return 1;
  }

  let input;
  try {
    input = useStdin ? readFileSync(0, 'utf-8') : readFileSync(file, 'utf-8');
  } catch (e) {
    console.error(`cannot read ${file}: ${e.message}`);
    return 1;
  }

  const result = scan(input, {
    file: useStdin ? '' : file,
    kind: forced,
    textOnly: args.includes('--text-only'),
    lookOnly: args.includes('--look-only'),
  });
  console.log(json ? JSON.stringify({ file, ...result }, null, 2) : report(result, file, args.includes('--full')));
  if (failOn && countAtOrAbove(result, failOn) > 0) return 2;
  if (failOnLook && countAtOrAbove(result, failOnLook, 'look') > 0) return 2;
  return 0;
}

// Run as a command, not when imported. Compare real paths: the script may be reached through a
// symlink (an installed skill) or a folder whose name has a space, and a URL spells both differently.
const realOf = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return '';
  }
};
// exitCode, not exit(): a large report piped to another process must flush before Node stops.
if (process.argv[1] && realOf(process.argv[1]) === realOf(fileURLToPath(import.meta.url))) process.exitCode = main(process.argv);
