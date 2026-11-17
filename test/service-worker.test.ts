// The service worker module, imported against a mocked chrome. An MV3 worker
// must register its event listeners synchronously when it is evaluated, or the
// browser does not wake it for the event. Every async chrome call here returns
// a promise that never settles, so only code that runs during evaluation can
// register a listener: anything registered after an await would be missing.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Listener = (...args: unknown[]) => unknown;

function event() {
  return { addListener: vi.fn((_listener: Listener) => undefined) };
}

/** A promise that never settles: nothing after an await on it runs. */
const pending = () => vi.fn((..._args: unknown[]) => new Promise<never>(() => undefined));

function mockChrome() {
  return {
    runtime: {
      id: "extension-id",
      getManifest: () => ({ action: { default_title: "Pathix" } }),
      getURL: (path: string) => `chrome-extension://extension-id/${path}`,
      openOptionsPage: pending(),
      onMessage: event(),
      onInstalled: event(),
    },
    storage: {
      local: { get: pending(), set: pending(), remove: pending() },
      session: { get: pending(), set: pending(), remove: pending() },
      managed: { get: pending() },
      onChanged: event(),
    },
    permissions: { contains: pending(), request: pending(), remove: pending(), onAdded: event(), onRemoved: event() },
    scripting: { getRegisteredContentScripts: pending(), registerContentScripts: pending(), unregisterContentScripts: pending() },
    action: {
      setBadgeBackgroundColor: pending(),
      setBadgeTextColor: pending(),
      setBadgeText: pending(),
      setTitle: pending(),
      onClicked: event(),
    },
    tabs: { query: pending(), sendMessage: pending(), create: pending(), onUpdated: event(), onRemoved: event() },
    commands: { onCommand: event() },
    identity: { getRedirectURL: () => "https://extension-id.chromiumapp.org/", launchWebAuthFlow: pending() },
  };
}

let chromeMock: ReturnType<typeof mockChrome>;

beforeEach(async () => {
  vi.resetModules();
  chromeMock = mockChrome();
  vi.stubGlobal("chrome", chromeMock);
  await import("../src/background/service-worker");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function installedListener(): Listener {
  expect(chromeMock.runtime.onInstalled.addListener).toHaveBeenCalledTimes(1);
  return chromeMock.runtime.onInstalled.addListener.mock.calls[0]![0];
}

describe("the service worker's onInstalled listener", () => {
  it("is registered once, synchronously, when the worker is evaluated", () => {
    expect(typeof installedListener()).toBe("function");
  });

  it("removes the client ID an earlier build stored when the extension is updated", () => {
    installedListener()({ reason: "update" });
    expect(chromeMock.storage.local.remove).toHaveBeenCalledWith("clientId");
  });

  it.each(["install", "chrome_update"])("leaves storage alone on %s", (reason) => {
    installedListener()({ reason });
    expect(chromeMock.storage.local.remove).not.toHaveBeenCalled();
  });
});

describe("the service worker's address listener", () => {
  function addressListener(): Listener {
    const listeners = chromeMock.storage.onChanged.addListener.mock.calls.map((call) => call[0]);
    return listeners[listeners.length - 1]!;
  }

  it("drops the token, the confirmed sign-in and any refusal when the address changes or is removed", () => {
    for (const newValue of ["https://pathix.fabrikam.com", undefined]) {
      chromeMock.storage.session.remove.mockClear();
      addressListener()({ pathixUrl: { oldValue: "https://pathix.contoso.com", newValue } }, "local");
      expect(chromeMock.storage.session.remove).toHaveBeenCalledWith("signInRefusal");
    }
  });

  it("changes nothing when the same address is saved again, or another setting changes", () => {
    addressListener()({ pathixUrl: { oldValue: "https://pathix.contoso.com", newValue: "https://pathix.contoso.com" } }, "local");
    addressListener()({ hideTips: { oldValue: false, newValue: true } }, "local");
    expect(chromeMock.storage.session.remove).not.toHaveBeenCalled();
  });
});

describe("the service worker's other listeners", () => {
  it("are all registered synchronously, so the browser can wake the worker for them", () => {
    expect(chromeMock.runtime.onMessage.addListener).toHaveBeenCalledTimes(1);
    expect(chromeMock.storage.onChanged.addListener).toHaveBeenCalledTimes(2);
    expect(chromeMock.permissions.onAdded.addListener).toHaveBeenCalledTimes(1);
    expect(chromeMock.permissions.onRemoved.addListener).toHaveBeenCalledTimes(1);
    expect(chromeMock.tabs.onUpdated.addListener).toHaveBeenCalledTimes(1);
    expect(chromeMock.commands.onCommand.addListener).toHaveBeenCalledTimes(1);
    expect(chromeMock.tabs.onRemoved.addListener).toHaveBeenCalledTimes(1);
  });

  // The toolbar button opens the popup (manifest action.default_popup), and
  // Chrome then never fires onClicked: a listener there would be dead code.
  it("does not listen for toolbar clicks, which the popup receives instead", () => {
    expect(chromeMock.action.onClicked.addListener).not.toHaveBeenCalled();
  });
});
