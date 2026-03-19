import { CONFERENCE_TYPE_OPTIONS } from "../conference-config";

const BOOL_OPTIONS = [
  { value: "no", labelKey: "common.no" },
  { value: "yes", labelKey: "common.yes" }
];

const ConferenceSettingsSection = ({
  t,
  settings,
  status,
  statusMessage,
  saving,
  onSettingChange,
  onOptionChange,
  onSave
}) => {
  const type = settings.type;

  return (
    <div className="conference-section">
      <h3>{t("conference.title")}</h3>
      <div className="settings-grid">
        <label className="property-field">
          <span className="property-label">{t("conference.enabled")}</span>
          <select
            className="input"
            value={settings.enabled ? "yes" : "no"}
            onChange={(event) => onSettingChange("enabled", event.target.value === "yes")}
          >
            {BOOL_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {t(option.labelKey)}
              </option>
            ))}
          </select>
        </label>
        <label className="property-field">
          <span className="property-label">{t("conference.systemType")}</span>
          <select className="input" value={type} onChange={(event) => onSettingChange("type", event.target.value)}>
            {CONFERENCE_TYPE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {t(option.labelKey)}
              </option>
            ))}
          </select>
        </label>
        <label className="property-field">
          <span className="property-label">{t("conference.deviceIp")}</span>
          <input
            className="input"
            value={settings.deviceIp || ""}
            disabled={type === "virtual"}
            onChange={(event) => onSettingChange("deviceIp", event.target.value)}
            placeholder={t(type === "virtual" ? "conference.notRequired" : "conference.deviceIpPlaceholder")}
          />
        </label>
        {type === "dcs150" && (
          <label className="property-field">
            <span className="property-label">{t("conference.bindIp")}</span>
            <input
              className="input"
              value={settings.bindIp || ""}
              onChange={(event) => onSettingChange("bindIp", event.target.value)}
              placeholder={t("conference.bindIpPlaceholder")}
            />
          </label>
        )}
        <label className="property-field">
          <span className="property-label">{t("conference.timeoutMs")}</span>
          <input
            className="input"
            type="number"
            min={200}
            value={settings.options?.timeoutMs ?? 1500}
            onChange={(event) => onOptionChange("timeoutMs", Number(event.target.value) || 1500)}
          />
        </label>
        {type === "dcs150" && (
          <label className="property-field">
            <span className="property-label">{t("conference.healthTimeoutMs")}</span>
            <input
              className="input"
              type="number"
              min={1000}
              value={settings.options?.healthTimeoutMs ?? 15000}
              onChange={(event) => onOptionChange("healthTimeoutMs", Number(event.target.value) || 15000)}
            />
          </label>
        )}
        {type === "virtual" && (
          <label className="property-field">
            <span className="property-label">{t("conference.virtualLatencyMs")}</span>
            <input
              className="input"
              type="number"
              min={0}
              value={settings.options?.virtualLatencyMs ?? 80}
              onChange={(event) => onOptionChange("virtualLatencyMs", Number(event.target.value) || 0)}
            />
          </label>
        )}
        <label className="property-field">
          <span className="property-label">{t("conference.debug")}</span>
          <select
            className="input"
            value={settings.options?.debug ? "yes" : "no"}
            onChange={(event) => onOptionChange("debug", event.target.value === "yes")}
          >
            {BOOL_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {t(option.labelKey)}
              </option>
            ))}
          </select>
        </label>
      </div>
      {status && (
        <p className="log-empty">
          {t("conference.statusLine", {
            driver: status.activeDriver || "—",
            health: status.health?.status || t("conference.health.unknown")
          })}
          {status.health?.reason ? ` (${status.health.reason})` : ""}
        </p>
      )}
      {statusMessage && <p className="log-empty">{statusMessage}</p>}
      <div className="log-modal__actions">
        <button type="button" className="button" disabled={saving} onClick={onSave}>
          {saving ? t("conference.saving") : t("conference.save")}
        </button>
      </div>
    </div>
  );
};

export default ConferenceSettingsSection;
