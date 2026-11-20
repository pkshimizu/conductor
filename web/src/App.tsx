/**
 * 画面の全体。言語（localStorage）・配色（PC の設定）・URL・稼働状態（SSE）を持ち、
 * 共通の枠（Layout）に渡す。各画面の中身は後の Issue で作る
 */
import { type ReactElement, useEffect, useState } from "react";
import { type AdminInfo, EVENTS_URL, parseEvent } from "./events.js";
import { type Lang, MESSAGES } from "./i18n.js";
import { loadLanguage, saveLanguage } from "./language.js";
import { Layout } from "./Layout.js";
import { menuOf } from "./routes.js";
import { DARK_QUERY, type Scheme, watchColorScheme } from "./theme.js";

/** 稼働状態などを SSE で受け取る。つながらなくなったら停止中として示す */
function useAdminInfo(): AdminInfo | undefined {
  const [info, setInfo] = useState<AdminInfo>();
  useEffect(() => {
    const source = new EventSource(EVENTS_URL);
    source.onmessage = (event: MessageEvent<string>) => {
      const next = parseEvent(event.data);
      if (next !== undefined) setInfo(next);
    };
    source.onerror = () => {
      setInfo((prev) => {
        if (prev === undefined) return prev;
        return { ...prev, status: "stopped" };
      });
    };
    return () => source.close();
  }, []);
  return info;
}

function systemScheme(): Scheme {
  return window.matchMedia(DARK_QUERY).matches ? "dark" : "light";
}

function storedLanguage(): Lang {
  return loadLanguage(window.localStorage);
}

function useColorScheme(): Scheme {
  const [scheme, setScheme] = useState<Scheme>(systemScheme);
  useEffect(() => {
    const watch = watchColorScheme((q) => window.matchMedia(q), setScheme);
    setScheme(watch.scheme);
    return () => watch.stop();
  }, []);
  return scheme;
}

function usePath(): [string, (path: string) => void] {
  const [path, setPath] = useState(() => window.location.pathname);
  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const navigate = (next: string) => {
    if (next === window.location.pathname) return;
    window.history.pushState(null, "", next);
    setPath(next);
  };
  return [path, navigate];
}

export function App(): ReactElement | null {
  const [lang, setLang] = useState<Lang>(storedLanguage);
  const scheme = useColorScheme();
  const [path, navigate] = usePath();
  const info = useAdminInfo();

  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  if (info === undefined) return null;
  const t = MESSAGES[lang];
  const titles = {
    dashboard: t.navDashboard,
    tasks: t.navTasks,
    settings: t.navSettings,
  };
  const changeLanguage = (next: Lang) => {
    saveLanguage(window.localStorage, next);
    setLang(next);
  };

  return (
    <Layout
      path={path}
      lang={lang}
      scheme={scheme}
      repo={info.repo}
      project={info.project}
      status={info.status}
      onLanguage={changeLanguage}
      onNavigate={navigate}
    >
      <h1 style={{ margin: 0, fontSize: 20 }}>{titles[menuOf(path)]}</h1>
    </Layout>
  );
}
