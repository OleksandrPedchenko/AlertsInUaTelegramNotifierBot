"use strict";

class AlertMessageCatalog {
  constructor() {
    this.messageBuilders = {
      A: (ctx) =>
        this.asBold(
          `‼️ Повітряна тривога: ${this.escapeHtml(ctx.regionName || "Невідомий регіон")} ‼️`
        ),
      N: (ctx) =>
        this.asBold(
          `✅ Відбій повітряної тривоги: ${this.escapeHtml(ctx.regionName || "Невідомий регіон")}`
        ),
      P: (ctx) =>
        this.asBold(
          [
            "Статус: P",
            "Часткова тривога в районах чи громадах.",
            "",
            `Region: ${this.escapeHtml(ctx.regionName || "Unknown region")}`,
            `Region ID: ${this.escapeHtml(ctx.regionId)}`,
            `Source: ${this.escapeHtml(ctx.source || "api")}`,
            `Time: ${this.escapeHtml(ctx.time)}`
          ].join("\n")
        )
    };
  }

  asBold(text) {
    return `<b>${text}</b>`;
  }

  escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  getMessageByStatus(status, context = {}) {
    const normalizedStatus = String(status || "").trim().toUpperCase();
    const builder = this.messageBuilders[normalizedStatus];
    const safeContext = {
      ...context,
      time: context.time || new Date().toISOString()
    };

    if (builder) {
      return builder(safeContext);
    }

    return this.asBold(
      [
        "Air Raid Alert: UNKNOWN",
        `Received status: ${this.escapeHtml(normalizedStatus || "EMPTY")}`,
        "",
        `Region: ${this.escapeHtml(safeContext.regionName || "Unknown region")}`,
        `Region ID: ${this.escapeHtml(safeContext.regionId)}`,
        `Source: ${this.escapeHtml(safeContext.source || "api")}`,
        `Time: ${this.escapeHtml(safeContext.time)}`
      ].join("\n")
    );
  }
}

module.exports = {
  AlertMessageCatalog
};
