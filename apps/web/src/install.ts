// Installing the web app (Chrome, Edge, Android): the browser offers it once it finds the
// app installable; the offer is kept here for the Settings page's "Install app" button.

import { create } from "zustand";

interface InstallPrompt extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export const useInstall = create<{ prompt: InstallPrompt | null }>()(() => ({ prompt: null }));

export function followInstallPrompt() {
  window.addEventListener("beforeinstallprompt", (e) => {
    // Shown from Settings rather than straight away.
    e.preventDefault();
    useInstall.setState({ prompt: e as InstallPrompt });
  });
  window.addEventListener("appinstalled", () => useInstall.setState({ prompt: null }));
}

/** Asks the browser to install the app. */
export async function install() {
  const prompt = useInstall.getState().prompt;
  if (!prompt) return;
  await prompt.prompt();
  await prompt.userChoice;
  useInstall.setState({ prompt: null });
}
