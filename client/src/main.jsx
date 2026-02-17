import React from "react";
import ReactDOM from "react-dom/client";
import { useEffect, useState } from "react";
import App from "./App.jsx";
import "./App.css";

const AuthGate = () => {
  const [checked, setChecked] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [username, setUsername] = useState("");
  const [loginUsername, setLoginUsername] = useState("admin");
  const [loginPassword, setLoginPassword] = useState("admin");
  const [loginError, setLoginError] = useState("");

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
      setLoginError("Invalid username or password.");
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

  if (!checked) {
    return <main className="auth-page">Loading...</main>;
  }

  if (!authenticated) {
    return (
      <main className="auth-page">
        <form className="auth-card" onSubmit={handleLogin}>
          <h1>Login</h1>
          <label className="property-field">
            <span className="property-label">Username</span>
            <input className="input" value={loginUsername} onChange={(event) => setLoginUsername(event.target.value)} />
          </label>
          <label className="property-field">
            <span className="property-label">Password</span>
            <input
              className="input"
              type="password"
              value={loginPassword}
              onChange={(event) => setLoginPassword(event.target.value)}
            />
          </label>
          {loginError && <p className="auth-error">{loginError}</p>}
          <button type="submit" className="button">
            Sign in
          </button>
        </form>
      </main>
    );
  }

  return <App onLogout={handleLogout} username={username} />;
};

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <AuthGate />
  </React.StrictMode>
);
