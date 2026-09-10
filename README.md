# VANGUARD — Terra Flux

A polished, real-time online browser grand-strategy territory-control game inspired by the accessible feel of OpenFront.io, built with **completely original** branding, UI, artwork, code, maps and audio.

> Living map • Committed attacks • Economy • Ports & Naval • Diplomacy • Superweapons

## Quick Start

```bash
pip install -r requirements.txt
python main.py
```

Open http://127.0.0.1:8000

Server binds `0.0.0.0:8000` (preview works via `https://{port}-{sandbox}.e2b.app`).

No npm, Node, Vite, React, or build step required — just Python + browser.

## Features

- **Living battlefield** — borders shift continuously, troops move visibly, construction pulses, capture transitions
- **Committed combat** — choose attack ratio (10-95%), attacks travel over seconds, reinforce, retreat, terrain & defense matter
- **Economy** — Gold & troops grow per territory; City (+pop/gold/troops), Factory (+production), Port (+gold & naval), Defense Post (+defense), Spectre Silo (missile)
- **Naval** — coastal territories, ports unlock sea assaults; ships arc over water, trade income via ports
- **Diplomacy** — request/accept/break alliances, allies cannot be attacked, quick-chat (Help/Attack/Alliance/Warning)
- **Strategic missile** — late-game silo, 500 gold, 45s cooldown, 5s warning, area damage with counterplay
- **AI** — Easy/Medium/Hard/Extreme/Insane, personalities: Aggressive, Defensive, Economic, Naval, Balanced
- **Maps** — World, Big World, Asia, Europe, USA, Africa, Iran, Iraq, Strait of Hormuz (all JSON-driven, recognizable geography)
- **Lobby** — create/join, host controls, bot count/difficulty, game speed, fog of war, superweapons toggle
- **Mobile** — drag/pan, pinch zoom, large touch targets, collapsible panels; Desktop — WASD, wheel zoom, Q/E, C to center, T/Y ratio
- **Audio** — WebAudio SFX (select/attack/build/alert) + chill procedural music (3 evolving pads) with volume controls
- **PWA** — manifest + service worker, installable, cached static assets (multiplayer requires online)

## Maps

All maps in `maps/*.json` with `{id,name,width,height,territories:[{id,name,x,y,neighbors,terrain,coastal,isWater}]}`.
Add a new map by dropping a JSON file — no engine changes needed.

| Map | Territories | Focus |
|-----|-------------|-------|
| world | 50 | Global, 60 countries incl. Japan, USA, UK, Canada, Australia |
| big_world | 65 | Detailed provinces for large matches |
| asia | 33 | East Asia + Middle East |
| europe | 21 | European theater |
| usa | 50 | US states |
| africa | 37 | African continent |
| iran | 31 | Iranian provinces |
| iraq | 18 | Iraqi governorates |
| hormuz | 23 | Strait of Hormuz — narrow sea, ports, chokepoints |

## Controls

- **Left click** territory → select; with own source selected, click enemy/neutral neighbor → attack (or Port-enabled naval to any coastal)
- **Right click** → context select
- **Drag** → pan, **Wheel** → zoom, **Q/E** → zoom, **C** → center on own, **T/Y** → ratio ±5%, **Ctrl+Wheel** → ratio
- **Mobile** — one-finger drag, pinch zoom, tap select, bottom dock (Attack/Build/Diplo/Naval/Strike)

## Project Structure

```
main.py          # FastAPI + WebSocket authoritative server
requirements.txt # fastapi, uvicorn, websockets
maps/*.json      # 9 maps
static/
  index.html
  style.css
  game.js        # Canvas, camera, HUD, audio
  manifest.json
  sw.js
```

## Development

The server is authoritative: troops, gold, ownership, construction, combat, AI, diplomacy, victory — all validated server-side. Client sends *intentions*, server decides outcomes. Multiple lobbies are isolated; disconnect keeps slot for 60s to allow reconnect.

Run tests manually:
- open http://127.0.0.1:8000 → Solo → pick map → play
- open two browsers → Create lobby + Join by code → test multiplayer
- test attack → build city → port → naval → diplomacy → missile

## License

Original code, maps, and assets — no OpenFront copyrighted material is included.
