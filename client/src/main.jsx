import React from "react";
import ReactDOM from "react-dom/client";
import { useEffect, useState } from "react";
import App from "./App.jsx";
import "./App.css";
import { LANGUAGE_STORAGE_KEY, languageOptions, normalizeLanguage, translate } from "./i18n";

const AuthGate = () => {
  const [checked, setChecked] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [username, setUsername] = useState("");
  const [loginUsername, setLoginUsername] = useState("admin");
  const [loginPassword, setLoginPassword] = useState("admin");
  const [loginError, setLoginError] = useState("");
  const [language, setLanguage] = useState(() => {
    const saved = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
    if (saved) {
      return normalizeLanguage(saved);
    }
    return normalizeLanguage(navigator.language?.slice(0, 2));
  });

  const isLoginRoute = window.location.pathname === "/login";

  const fetchAuth = async () => {
    const response = await fetch("/api/auth/me");
    if (!response.ok) {
      setAuthenticated(false);
      setUsername("");
      setChecked(true);
      return;
    }

    const data = await response.json();
    setAuthenticated(Boolean(data.authenticated));
    setUsername(data.username || "");
    setChecked(true);
  };

  useEffect(() => {
    fetchAuth();
  }, []);

  useEffect(() => {
    if (!checked) {
      return;
    }

    if (!authenticated && !isLoginRoute) {
      window.history.replaceState({}, "", "/login");
      return;
    }

    if (authenticated && isLoginRoute) {
      window.history.replaceState({}, "", "/");
    }
  }, [checked, authenticated, isLoginRoute]);

  const handleLogin = async (event) => {
    event.preventDefault();
    setLoginError("");

    const response = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: loginUsername, password: loginPassword })
    });

    if (!response.ok) {
      setLoginError(translate(language, "auth.error.invalidCredentials"));
      return;
    }

    await fetchAuth();
    window.history.replaceState({}, "", "/");
  };

  const handleLogout = async () => {
    await fetch("/api/logout", { method: "POST" });
    setAuthenticated(false);
    setUsername("");
    window.history.replaceState({}, "", "/login");
  };

  const handleLanguageChange = (nextLanguage) => {
    const normalized = normalizeLanguage(nextLanguage);
    setLanguage(normalized);
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, normalized);
  };

  if (!checked) {
    return <main className="auth-page">{translate(language, "auth.loading")}</main>;
  }

  if (!authenticated) {
    return (
      <main className="auth-page">
        <form className="auth-card" onSubmit={handleLogin}>
          <h1>{translate(language, "auth.login")}</h1>
          <label className="property-field">
            <span className="property-label">{translate(language, "language.select")}</span>
            <select className="input" value={language} onChange={(event) => handleLanguageChange(event.target.value)}>
              {languageOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label className="property-field">
            <span className="property-label">{translate(language, "auth.username")}</span>
            <input className="input" value={loginUsername} onChange={(event) => setLoginUsername(event.target.value)} />
          </label>
          <label className="property-field">
            <span className="property-label">{translate(language, "auth.password")}</span>
            <input
              className="input"
              type="password"
              value={loginPassword}
              onChange={(event) => setLoginPassword(event.target.value)}
            />
          </label>
          {loginError && <p className="auth-error">{loginError}</p>}
          <button type="submit" className="button">
            {translate(language, "auth.signIn")}
          </button>
        </form>
      </main>
    );
  }

  return <App onLogout={handleLogout} username={username} language={language} onLanguageChange={handleLanguageChange} />;
};

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <AuthGate />
  </React.StrictMode>
);
