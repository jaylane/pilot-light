<p align="center">
  <img src="assets/pilot-light.png" alt="Pilot Light" width="200">
</p>

<h1 align="center">Pilot Light</h1>

<p align="center"><a href="https://github.com/jaylane/pilot-light/actions/workflows/ci.yml"><img src="https://github.com/jaylane/pilot-light/actions/workflows/ci.yml/badge.svg" alt="CI"></a><a href="https://github.com/jaylane/pilot-light/actions/workflows/release.yml"><img src="https://github.com/jaylane/pilot-light/actions/workflows/release.yml/badge.svg" alt="Release"></a></p>

A Claude Code mod that keeps an eye on your prompt cache. It draws one strip above the prompt box:

```
🔥 4:32 /5m · 🔁 7 $0.41/$2.50   🧠 220k/1.0M (22%)   📊 5h 24% · 7d 41%   💰 $12.34   🧊 next $2.75 (warm $0.06)   💸 saved $41.20   [ 📋🧹 ]
```

- **🔥** counts down until the prompt cache goes cold, anchored on the start of the last API request. The window (5m or 1h) is read from the API's own usage breakdown in the transcript; until then the configured default shows with a `?`.
- **🧠** is the context size the next request re-sends, against the model's window.
- **📊** 5h / 7d are your rate-limit windows, when the account reports them.
- **💰** is what the session would have cost at API list prices.
- **💸 saved** is the lifetime total of cold re-sends the keep-alive avoided, less what the pings cost, kept across sessions.
- **🧊 next** is the cache write the next message would pay if the cache expired, with the cache-read price it pays while warm.

Five minutes before the cache goes cold (or at half the window, when the window is shorter) you get a native notification. If you have not replied by twenty seconds before expiry, the mod forks the cached conversation with a one-word prompt, which refreshes the cache without touching your transcript. Pings stop once a stretch has cost as much as one cold re-send would, and start again when you next press Enter. A `/loop`, cron or background task does not re-arm them.

**📋🧹 (Handoff & Clear)** asks the model for a sub-400-word handoff brief over the cached transcript, saves it under `~/.claude/pilot-light/`, runs `/clear`, and pastes the brief (plus anything you had typed) into the fresh prompt box. You press Enter to send it.

## Install

At the prompt of a terminal session:

```
/plugin install pilot-light --marketplace jaylane/pilot-light
```

Answer `y` to add the marketplace, then pick a scope. From a shell:

```
claude plugin install pilot-light --marketplace jaylane/pilot-light
```

In the desktop app, click + next to the prompt box, then Plugins, Add marketplace with `jaylane/pilot-light`, then Add plugin.

## Settings

In `/config`:

- **Cache window (minutes)**: the lifetime assumed until the real one is detected. Default 60.
- **Keep-alive pings**: on or off. Default on.

## Development

```
claude plugin validate .
claude plugin test .
tsc -p .
```

Or run a session with the folder loaded: `claude --plugin-dir .`

CI runs validate and test on every push and pull request. To release, bump `version` in `.claude-plugin/plugin.json`, commit, then tag it:

```
git tag v0.3.1 && git push origin v0.3.1
```

The release workflow re-runs the checks, confirms the tag matches the manifest version, and publishes a GitHub release with generated notes. Installed copies pick it up with `claude plugin update pilot-light`.

## License

MIT. See `LICENSE`.
