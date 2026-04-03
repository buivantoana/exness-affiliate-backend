import fs from "node:fs/promises";
import path from "node:path";

const DATA_FILE = path.resolve("server/db/data.json");
const LINK_FIELDS = [
  "registerLink",
  "signInLink",
  "tryDemoLink",
  "liveChatLink",
  "tradingLink",
  "marketsLink",
  "platformsLink",
  "toolsLink",
  "companyLink",
  "partnersLink",
  "metatrader5Link",
  "exnessTerminalLink",
  "exnessTradeAppLink",
  "clientProtectionLink",
  "whyExnessLink",
  "appDownloadLink"
];

const DEFAULT_DOMAIN_CONFIG = {
  defaultLanguage: "en",
  botCheckRedirectUrl: "",
  registerLink: "",
  signInLink: "",
  tryDemoLink: "",
  liveChatLink: "",
  tradingLink: "",
  marketsLink: "",
  platformsLink: "",
  toolsLink: "",
  companyLink: "",
  partnersLink: "",
  metatrader5Link: "",
  exnessTerminalLink: "",
  exnessTradeAppLink: "",
  clientProtectionLink: "",
  whyExnessLink: "",
  appDownloadLink: "",
  subPaths: [],
  subPathConfigs: {},
  blockedCountries: [],
  blockedIPs: [],
  blockAction: "403",
  blockRedirectUrl: "",
  createdAt: "",
  updatedAt: "",
  gtmContainerId: "",      // ⭐ THÊM
  ga4MeasurementId: "",    // ⭐ THÊM
};

let writeQueue = Promise.resolve();

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

async function ensureFile() {
  try {
    await fs.access(DATA_FILE);
  } catch {
    const payload = { domains: {}, clicks: {} };
    await fs.mkdir(path.dirname(DATA_FILE), { recursive: true });
    await fs.writeFile(DATA_FILE, JSON.stringify(payload, null, 2));
  }
}

async function readData() {
  await ensureFile();
  const content = await fs.readFile(DATA_FILE, "utf8");
  const data = JSON.parse(content || "{}");
  data.domains ??= {};
  data.clicks ??= {};
  return data;
}

function queueWrite(mutator) {
  writeQueue = writeQueue.then(async () => {
    const data = await readData();
    const nextData = await mutator(data);
    await fs.writeFile(DATA_FILE, JSON.stringify(nextData, null, 2));
    return nextData;
  });
  return writeQueue;
}

function normalizeDomain(input) {
  return String(input || "")
    .trim()
    .toLowerCase()
    .replace(/:\d+$/, "");
}

function sanitizeSubPath(input) {
  return String(input || "")
    .trim()
    .replace(/^\/+|\/+$/g, "")
    .toLowerCase();
}

function normalizeSubPathConfigs(subPaths = [], subPathConfigs = {}) {
  const normalized = {};
  for (const subPath of subPaths) {
    const key = sanitizeSubPath(subPath);
    if (!key) {
      continue;
    }
    normalized[key] = {
      ...(subPathConfigs[key] || {})
    };
  }
  return normalized;
}

function buildConfig(config = {}) {
  return {
    ...clone(DEFAULT_DOMAIN_CONFIG),
    ...clone(config),
    subPaths: [...new Set((config.subPaths || []).map(sanitizeSubPath).filter(Boolean))],
    subPathConfigs: normalizeSubPathConfigs(config.subPaths || [], config.subPathConfigs || {})
  };
}

function resolveLinkFallbacks(config) {
  const result = clone(config);
  for (const field of LINK_FIELDS) {
    if (!result[field]) {
      result[field] = result.registerLink || "";
    }
  }
  if (!result.botCheckRedirectUrl) {
    result.botCheckRedirectUrl = result.registerLink || "";
  }
  return result;
}

function mergeDomainConfig(config, subPath) {
  const normalized = buildConfig(config);
  const key = sanitizeSubPath(subPath);
  const override = key ? normalized.subPathConfigs[key] || {} : {};
  const merged = {
    ...normalized,
    ...override,
    subPaths: normalized.subPaths,
    subPathConfigs: normalized.subPathConfigs
  };
  return resolveLinkFallbacks(merged);
}

export function getLinkFields() {
  return [...LINK_FIELDS];
}

export async function getAllDomains() {
  const data = await readData();
  return clone(data.domains);
}

export async function getDomainConfig(domain) {
  const data = await readData();
  const key = normalizeDomain(domain);
  return data.domains[key] ? buildConfig(data.domains[key]) : null;
}

export async function upsertDomainConfig(domain, config) {
  const key = normalizeDomain(domain);
  if (!key) {
    throw new Error("Domain is required");
  }

  const now = new Date().toISOString();
  const saved = await queueWrite((data) => {
    const existing = data.domains[key] || null;
    const nextConfig = buildConfig(config);
    nextConfig.createdAt = existing?.createdAt || now;
    nextConfig.updatedAt = now;
    data.domains[key] = nextConfig;
    return data;
  });

  return buildConfig(saved.domains[key]);
}

export async function deleteSubPath(domain, subPath) {
  const key = normalizeDomain(domain);
  const subPathKey = sanitizeSubPath(subPath);
  if (!subPathKey) {
    throw new Error("Sub-path is required");
  }

  const saved = await queueWrite((data) => {
    const current = buildConfig(data.domains[key] || {});
    current.subPaths = current.subPaths.filter((item) => item !== subPathKey);
    delete current.subPathConfigs[subPathKey];
    current.updatedAt = new Date().toISOString();
    data.domains[key] = current;
    return data;
  });

  return buildConfig(saved.domains[key]);
}

export async function upsertSubPathConfig(domain, subPath, subPathConfig = {}) {
  const key = normalizeDomain(domain);
  const subPathKey = sanitizeSubPath(subPath);
  if (!key || !subPathKey) {
    throw new Error("Domain and sub-path are required");
  }

  const saved = await queueWrite((data) => {
    const current = buildConfig(data.domains[key] || {});
    if (!current.createdAt) {
      current.createdAt = new Date().toISOString();
    }
    current.updatedAt = new Date().toISOString();
    if (!current.subPaths.includes(subPathKey)) {
      current.subPaths.push(subPathKey);
    }
    current.subPaths = [...new Set(current.subPaths.map(sanitizeSubPath).filter(Boolean))];
    current.subPathConfigs[subPathKey] = {
      ...(current.subPathConfigs[subPathKey] || {}),
      ...clone(subPathConfig)
    };
    data.domains[key] = current;
    return data;
  });

  return buildConfig(saved.domains[key]);
}

export async function getResolvedConfig(domain, subPath) {
  const config = await getDomainConfig(domain);
  return config ? mergeDomainConfig(config, subPath) : null;
}

export async function listSubPaths(domain) {
  const config = await getDomainConfig(domain);
  return config?.subPaths || [];
}

export async function listSubPathConfigs(domain) {
  const config = await getDomainConfig(domain);
  return clone(config?.subPathConfigs || {});
}

export async function getAnalytics(domain) {
  const data = await readData();
  const key = normalizeDomain(domain);
  return clone(data.clicks[key] || {});
}

export async function incrementClick(domain, routeKey) {
  const key = normalizeDomain(domain);
  const today = new Date().toISOString().slice(0, 10);
  const saved = await queueWrite((data) => {
    data.clicks[key] ??= {};
    data.clicks[key][routeKey] ??= { total: 0 };
    data.clicks[key][routeKey][today] = (data.clicks[key][routeKey][today] || 0) + 1;
    data.clicks[key][routeKey].total = (data.clicks[key][routeKey].total || 0) + 1;
    return data;
  });
  return clone(saved.clicks[key][routeKey]);
}

export function getDomainSummaryMap(domains) {
  return Object.entries(domains).map(([domain, config]) => ({
    domain,
    defaultLanguage: config.defaultLanguage || "en",
    subPaths: config.subPaths || [],
    updatedAt: config.updatedAt || null
  }));
}

export function normalizeHost(host) {
  return normalizeDomain(host);
}

export function normalizePathSegment(value) {
  return sanitizeSubPath(value);
}
