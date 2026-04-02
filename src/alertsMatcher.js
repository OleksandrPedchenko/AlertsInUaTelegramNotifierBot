"use strict";

class AlertsMatcher {
  constructor(alerts) {
    if (!Array.isArray(alerts)) {
      throw new TypeError("AlertsMatcher expects an array of alerts");
    }

    this.alerts = alerts;
  }

  findByCriteria(criteria) {
    this.assertCriteriaObject(criteria);

    return (
      this.alerts.find((alert) => this.matchesCriteria(alert, criteria)) || null
    );
  }

  matchesCriteria(alert, criteria) {
    if (!alert || typeof alert !== "object" || Array.isArray(alert)) {
      return false;
    }

    for (const [key, expectedValue] of Object.entries(criteria)) {
      if (!Object.prototype.hasOwnProperty.call(alert, key)) {
        return false;
      }

      if (!Object.is(alert[key], expectedValue)) {
        return false;
      }
    }

    return true;
  }

  assertCriteriaObject(criteria) {
    if (!criteria || typeof criteria !== "object" || Array.isArray(criteria)) {
      throw new TypeError("criteria must be a JSON object");
    }
  }
}

module.exports = {
  AlertsMatcher
};
