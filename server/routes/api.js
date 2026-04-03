import express from "express";
import { getResolvedConfig, listSubPaths, normalizePathSegment } from "../db/index.js";

function buildLinksResponse(config, domain, subPath) {
  return {
    registerLink: config.registerLink,
    signInLink: config.signInLink,
    tryDemoLink: config.tryDemoLink,
    liveChatLink: config.liveChatLink,
    tradingLink: config.tradingLink,
    marketsLink: config.marketsLink,
    platformsLink: config.platformsLink,
    toolsLink: config.toolsLink,
    companyLink: config.companyLink,
    partnersLink: config.partnersLink,
    metatrader5Link: config.metatrader5Link,
    exnessTerminalLink: config.exnessTerminalLink,
    exnessTradeAppLink: config.exnessTradeAppLink,
    clientProtectionLink: config.clientProtectionLink,
    whyExnessLink: config.whyExnessLink,
    appDownloadLink: config.appDownloadLink,
    botCheckRedirectUrl: config.botCheckRedirectUrl,
    defaultLanguage: config.defaultLanguage,
    domain,
    subpath: subPath || null,
    // ⭐ THÊM 2 DÒNG NÀY
    gtmContainerId: config.gtmContainerId || null,
    ga4MeasurementId: config.ga4MeasurementId || null
  };
}

export function createPublicApiRouter() {
  const router = express.Router();

  router.get("/links", async (req, res) => {
    const subPath = normalizePathSegment(req.query.subpath);
    const config = await getResolvedConfig(req.domainHost, subPath);
    if (!config) {
      return res.status(404).json({ success: false, error: "Domain config not found" });
    }
    return res.json(buildLinksResponse(config, req.domainHost, subPath));
  });

  router.get("/sub-paths", async (req, res) => {
    const subPaths = await listSubPaths(req.domainHost);
    return res.json({ subPaths });
  });

  router.get("/default-language", async (req, res) => {
    const subPath = normalizePathSegment(req.query.subpath);
    const config = await getResolvedConfig(req.domainHost, subPath);
    if (!config) {
      return res.status(404).json({ success: false, error: "Domain config not found" });
    }
    return res.json({ defaultLanguage: config.defaultLanguage });
  });

  return router;
}
