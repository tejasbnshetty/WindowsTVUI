import { useEffect, useState } from "preact/hooks";
import { ErrorBanner, ToastView, TopBar, Wallpaper } from "./Chrome";
import { activeWallpaper, type Controller, type UiState } from "./controller";
import { Home } from "./Home";
import { PairScreenView, ScreensaverView, SettingsScreen } from "./Views";

/** Re-renders whenever the controller's state changes. */
export function useControllerState(c: Controller): UiState {
  const [state, setState] = useState(c.getState());
  useEffect(() => {
    setState(c.getState());
    return c.subscribe(() => setState(c.getState()));
  }, [c]);
  return state;
}

export function App({ controller }: { controller: Controller }) {
  const s = useControllerState(controller);
  const pairing = controller.pairing();
  const wp = activeWallpaper(s.ui.wallpaper, s.wallpapers, s.rotateIndex);
  const lastApp = s.apps.find((a) => a.id === s.ui.lastLaunchedId);

  // "Reduce effects" is a class on <html> so every rule in styles.css can key off it.
  useEffect(() => {
    document.documentElement.classList.toggle("reduce-fx", s.ui.reduceEffects);
  }, [s.ui.reduceEffects]);

  const fullScreen = pairing.screen.kind !== "home" && s.info ? pairing.screen : null;

  return (
    <div class={`app${s.screen === "settings" ? " dim" : ""}${fullScreen ? " covered" : ""}`}>
      <Wallpaper wp={wp} />
      <TopBar info={s.info} chips={pairing.chips} />
      {s.ready && (
        <Home
          rows={s.rows}
          focus={s.focus}
          lastApp={lastApp}
          onActivateHero={() => controller.input("ok")}
          onClickTile={(r, c) => controller.clickTile(r, c)}
        />
      )}
      {s.screen === "settings" && !fullScreen && <SettingsScreen sections={controller.sections()} focus={s.settingsFocus} />}
      {fullScreen && s.info && <PairScreenView screen={fullScreen} info={s.info} />}
      <ErrorBanner text={s.info?.error ?? null} />
      <ToastView toast={s.toast} />
      <div class={`ss-host${s.screensaver ? " on" : ""}`}>{s.screensaver && <ScreensaverView slides={s.slideshow} />}</div>
    </div>
  );
}
