import express from "express";
import { getResolvedConfig, incrementClick, normalizePathSegment } from "../db/index.js";

const TYPE_TO_FIELD = {
  register: "registerLink",
  signin: "signInLink",
  demo: "tryDemoLink",
  livechat: "liveChatLink",
  trading: "tradingLink",
  markets: "marketsLink",
  platforms: "platformsLink",
  tools: "toolsLink",
  company: "companyLink",
  partners: "partnersLink",
  metatrader5: "metatrader5Link",
  "exness-terminal": "exnessTerminalLink",
  "exness-trade-app": "exnessTradeAppLink",
  "client-protection": "clientProtectionLink",
  "why-exness": "whyExnessLink",
  "app-download": "appDownloadLink"
};

export function createRedirectRouter() {
  const router = express.Router();

  router.get("/:type", async (req, res) => {
    const field = TYPE_TO_FIELD[req.params.type];
    if (!field) {
      return res.status(404).json({ success: false, error: "Unknown redirect type" });
    }

    const subPath = normalizePathSegment(req.query.subpath);
    const config = await getResolvedConfig(req.domainHost, subPath);
    if (!config) {
      return res.status(404).json({ success: false, error: "Domain config not found" });
    }

    const destination = config[field] || config.registerLink;
    if (!destination) {
      return res.status(400).json({ success: false, error: "Redirect URL is not configured" });
    }

    const routeKey = subPath ? `${subPath}/go/${req.params.type}` : `/go/${req.params.type}`;
    await incrementClick(req.domainHost, routeKey);
    return res.redirect(302, destination);
  });

  return router;
}
