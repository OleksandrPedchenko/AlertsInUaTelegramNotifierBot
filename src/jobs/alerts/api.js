"use strict";

const { HttpRequestError } = require("../../lib/httpClient");
const { AlertsMatcher } = require("./matcher");

const ALERT_STATES = new Set(["N", "A", "P"]);

function buildAlertsUrl({ host, pathTemplate, regionId }) {
  const path = pathTemplate.replace("{regionId}", encodeURIComponent(String(regionId)));
  return new URL(path, host).toString();
}

function parseAlertState(responseText) {
  const trimmed = String(responseText || "").trim();
  if (!trimmed) {
    return null;
  }

  let candidate = trimmed;
  if (
    (candidate.startsWith("\"") && candidate.endsWith("\"")) ||
    (candidate.startsWith("'") && candidate.endsWith("'"))
  ) {
    candidate = candidate.slice(1, -1).trim();
  }

  const state = candidate.toUpperCase();
  return ALERT_STATES.has(state) ? state : null;
}

function parseJsonBody(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function parseActiveAlerts(responseText, matchCriteria) {
  const payload = parseJsonBody(responseText);
  if (!payload || !Array.isArray(payload.alerts)) {
    throw new HttpRequestError("Unexpected active alerts API response. Expected JSON object with alerts array", {
      body: responseText,
      retriable: false
    });
  }

  if (!matchCriteria || typeof matchCriteria !== "object" || Array.isArray(matchCriteria)) {
    throw new HttpRequestError("Active alerts match criteria must be a JSON object", {
      body: responseText,
      retriable: false
    });
  }

  if (Object.keys(matchCriteria).length === 0) {
    throw new HttpRequestError("Active alerts match criteria must be a non-empty JSON object", {
      body: responseText,
      retriable: false
    });
  }

  const matcher = new AlertsMatcher(payload.alerts);
  const matchedAlert = matcher.findByCriteria(matchCriteria);
  return {
    alertState: matchedAlert ? "A" : "N",
    alertLevel: ["yellow", "red"].includes(matchedAlert?.alert_level)
      ? matchedAlert.alert_level
      : null
  };
}

function parseActiveAlertsState(responseText, matchCriteria) {
  return parseActiveAlerts(responseText, matchCriteria).alertState;
}

module.exports = {
  ALERT_STATES,
  buildAlertsUrl,
  parseAlertState,
  parseActiveAlertsState,
  parseActiveAlerts
};
