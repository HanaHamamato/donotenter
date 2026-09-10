import asyncio
import json
import os
import random
import time
import uuid
import math
from pathlib import Path
from typing import Dict, List, Optional, Set

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

app = FastAPI()

# Load maps
MAPS_DIR = Path("maps")
maps_data: Dict[str, dict] = {}
for fp in MAPS_DIR.glob("*.json"):
    try:
        with open(fp) as f:
            data = json.load(f)
            maps_data[data["id"]] = data
    except Exception as e:
        print(f"Failed load {fp}: {e}")
print(f"Loaded maps: {list(maps_data.keys())}")

# Static serving - mount after API routes
# Ensure static exists
STATIC_DIR = Path("static")
STATIC_DIR.mkdir(exist_ok=True)

COLORS = ["#e74c3c","#3498db","#2ecc71","#f1c40f","#9b59b6","#e67e22","#1abc9c","#34495e","#ff6b9d","#00d2ff","#ffa502","#7bed9f","#a55eea","#ff6348"]
BUILDING_DEFS = {
    "city": {"name":"City","icon":"🏙️","cost":100,"time":5,"desc":"+500 pop, +2 gold/s, +1 troop/s","pop":500,"gold":2,"troops":1},
    "factory": {"name":"Factory","icon":"🏭","cost":120,"time":6,"desc":"+40% troop production","troop_mult":0.4},
    "port": {"name":"Port","icon":"⚓","cost":150,"time":7,"desc":"Naval access +3 gold/s","gold":3,"requires_coastal":True},
    "defense": {"name":"Defense Post","icon":"🛡️","cost":80,"time":4,"desc":"+45% defense","defense":0.45},
    "silo": {"name":"Spectre Silo","icon":"🚀","cost":500,"time":15,"desc":"Enables strategic missile","missile":True},
}
TERRAIN_MODS = {
    "plains": {"defense":0.0, "move":1.0},
    "forest": {"defense":0.2, "move":0.9},
    "mountain": {"defense":0.4, "move":0.7},
    "desert": {"defense":-0.05, "move":1.0},
    "arctic": {"defense":0.1, "move":0.85},
}

DIFFICULTY = {
    "easy": {"speed":0.6, "smart":0.4, "econ":0.7},
    "medium": {"speed":0.85, "smart":0.6, "econ":0.85},
    "hard": {"speed":1.0, "smart":0.85, "econ":1.0},
    "extreme": {"speed":1.2, "smart":1.0, "econ":1.1},
    "insane": {"speed":1.4, "smart":1.0, "econ":1.3},
}
PERSONALITIES = ["balanced","aggressive","defensive","economic","naval"]

# In-memory state
lobbies: Dict[str, dict] = {}
connections: Dict[str, WebSocket] = {}
player_to_lobby: Dict[str, str] = {}
player_names: Dict[str, str] = {}
leaderboard: List[dict] = []  # persistent simple online leaderboard (in-memory)
# For reconnect: playerId -> lobbyId

def gen_id():
    return uuid.uuid4().hex[:8]

def get_map(map_id):
    return maps_data.get(map_id) or maps_data.get("world")

def create_territory_states(map_data):
    terrs = {}
    for t in map_data["territories"]:
        terrs[t["id"]] = {
            "id": t["id"],
            "name": t["name"],
            "x": t["x"],
            "y": t["y"],
            "neighbors": list(t.get("neighbors",[])),
            "terrain": t.get("terrain","plains"),
            "coastal": t.get("coastal", False),
            "isWater": t.get("isWater", False),
            "ownerId": None,
            "troops": 50 if not t.get("isWater") else 0,
            "buildings": {"city":0,"factory":0,"port":0,"defense":0,"silo":0},
            "building_progress": None, # {type, progress}
            "population": 1000,
        }
    return terrs

def assign_spawns(game):
    # Assign each player a random neutral land territory far apart
    terrs = [t for t in game["territories"].values() if not t["isWater"]]
    random.shuffle(terrs)
    players = list(game["players"].values())
    random.shuffle(players)
    # For fairness, pick spaced spawns: greedy max distance
    chosen=[]
    for p in players:
        best=None
        best_dist=-1
        candidates = terrs[:]
        random.shuffle(candidates)
        for t in candidates[:20]:
            if t["ownerId"] is not None:
                continue
            if not chosen:
                best=t
                break
            d = min(math.hypot(t["x"]-c["x"], t["y"]-c["y"]) for c in chosen)
            if d>best_dist:
                best_dist=d
                best=t
        if best:
            best["ownerId"]=p["id"]
            best["troops"]= 600 if game["settings"].get("startingTroops",500)>0 else 600
            # ensure not too close neighbor ownership conflict: mark neighbors as neutral but give small troops
            chosen.append(best)
        else:
            # fallback any neutral
            for t in terrs:
                if t["ownerId"] is None:
                    t["ownerId"]=p["id"]
                    t["troops"]=500
                    chosen.append(t)
                    break

def new_game(lobby):
    map_data = get_map(lobby["mapId"])
    game = {
        "lobbyId": lobby["id"],
        "mapId": map_data["id"],
        "mapName": map_data["name"],
        "width": map_data.get("width",1000),
        "height": map_data.get("height",600),
        "territories": create_territory_states(map_data),
        "players": {},
        "attacks": [],
        "ships": [],
        "constructions": [], # list of {id, territoryId, building, progress, ownerId}
        "events": [],
        "tick": 0,
        "startedAt": time.time(),
        "settings": dict(lobby["settings"]),
        "winner": None,
        "state": "countdown",
        "countdown": 5,
        "missile_cooldowns": {}, # playerId -> timestamp
        "alliances": {}, # playerId -> set allied playerIds
        "embargo": {}, # not used fully
    }
    # copy players from lobby
    for p in lobby["players"]:
        if p.get("isBot"):
            pid = p["id"]
            game["players"][pid] = {
                "id": pid,
                "name": p["name"],
                "color": p["color"],
                "isBot": True,
                "botDifficulty": p.get("botDifficulty","medium"),
                "personality": p.get("personality","balanced"),
                "gold": lobby["settings"].get("startingGold",500),
                "goldIncome": 0,
                "troops": 0,
                "territories": 0,
                "alive": True,
                "allies": set(),
                "eliminated": False,
            }
        else:
            pid = p["id"]
            game["players"][pid] = {
                "id": pid,
                "name": p["name"],
                "color": p["color"],
                "isBot": False,
                "gold": lobby["settings"].get("startingGold",500),
                "goldIncome": 0,
                "troops": 0,
                "territories": 0,
                "alive": True,
                "allies": set(),
                "eliminated": False,
            }
            game["alliances"][pid]=set()
    # alliances for bots pre-set? none
    assign_spawns(game)
    # give initial gold income calc
    recalc_player_stats(game)
    # add countdown events
    game["events"].append({"type":"info","message":f"Match starting on {map_data['name']}","ts":time.time()})
    lobby["game"]=game
    lobby["state"]="countdown"
    return game

def recalc_player_stats(game):
    # reset
    for p in game["players"].values():
        p["territories"]=0
        p["troops"]=0
        p["goldIncome"]=0
        p["troopIncome"]=0
    for t in game["territories"].values():
        owner = t["ownerId"]
        if owner and owner in game["players"]:
            pl = game["players"][owner]
            pl["territories"]+=1
            pl["troops"]+= t["troops"]
            # income
            base_gold = 0.8
            base_troop = 0.32
            # terrain influences? plains base
            city_lvl = t["buildings"].get("city",0)
            factory_lvl = t["buildings"].get("factory",0)
            port_lvl = t["buildings"].get("port",0)
            # gold
            g = base_gold + city_lvl*2.2 + port_lvl*3.2
            # troops
            tr = base_troop + city_lvl*0.7 + factory_lvl*0.5
            # factory multiplier
            if factory_lvl>0:
                tr *= (1 + 0.45*factory_lvl)
            pl["goldIncome"]+= g
            pl["troopIncome"]+= tr

def push_event(game, evt):
    evt["ts"]=time.time()
    evt["id"]=gen_id()
    game["events"].append(evt)
    # keep last 50
    if len(game["events"])>80:
        game["events"]=game["events"][-80:]

# Game tick logic
def game_tick(lobby):
    game = lobby.get("game")
    if not game or game["winner"]:
        return
    game["tick"]+=1
    # Handle countdown
    if game["state"]=="countdown":
        # countdown decremented every 1 sec (10 ticks)
        if game["tick"] % 10 == 0:
            game["countdown"]-=1
            # push event?
            if game["countdown"]<=0:
                game["state"]="playing"
                push_event(game, {"type":"info","message":"Battle begins! Expand and conquer!","important":True})
                lobby["state"]="playing"
            else:
                push_event(game, {"type":"countdown","message":f"Starting in {game['countdown']}...","seconds":game["countdown"]})
        return
    if game["state"]!="playing":
        return

    # Economy: every tick add income scaled by game speed and economic speed
    speed = float(game["settings"].get("gameSpeed",1.0))
    eco_speed = float(game["settings"].get("economicSpeed",1.0))
    # apply every tick but small amounts; we run 10 ticks per sec, so per tick add income/10
    dt = 0.1 * speed * eco_speed
    # Troop and gold growth per territory — parabolic near 42% of cap (OpenFront-style)
    for t in game["territories"].values():
        owner = t["ownerId"]
        if owner and owner in game["players"]:
            # troops
            city_lvl = t["buildings"].get("city",0)
            factory_lvl = t["buildings"].get("factory",0)
            base_troop = 0.32
            tr = base_troop + city_lvl*0.7
            if factory_lvl>0:
                tr = (tr)*(1+0.45*factory_lvl)
            cap = 3500 + city_lvl*1300 + 500
            if t["troops"] < cap:
                # growth peaks at 42% of cap
                p = t["troops"]/cap if cap else 0
                # parabolic factor: 1 - 4*(p-0.42)^2  (clamped)
                growth_factor = 1 - 4 * (p - 0.42) * (p - 0.42)
                growth_factor = max(0.08, growth_factor) # never stall, keep 8% minimum
                # workers vs troops split: if player has many troops globally, growth slows slightly (overextension)
                # For now use territory-local factor
                t["troops"] = min(cap, t["troops"] + tr*dt*growth_factor*1.8 )
            # population growth visual? ignore
            # gold per player (not per territory? we accumulate per player)
            # We'll handle gold globally later
            pass
    # Gold per player
    for pl in game["players"].values():
        if not pl["alive"]:
            continue
        inc = pl.get("goldIncome",0) * dt
        pl["gold"] += inc

    # Construction progress
    to_remove=[]
    for c in game["constructions"]:
        c["progress"] += dt / BUILDING_DEFS[c["building"]]["time"]
        if c["progress"]>=1.0:
            terr = game["territories"].get(c["territoryId"])
            if terr and terr["ownerId"]==c["ownerId"]:
                terr["buildings"][c["building"]] +=1
                push_event(game, {"type":"build","message":f"{game['players'][c['ownerId']]['name']} completed {BUILDING_DEFS[c['building']]['name']} in {terr['name']}","territoryId": terr["id"],"playerId": c["ownerId"]})
            to_remove.append(c)
    for c in to_remove:
        game["constructions"].remove(c)

    # Attacks progress
    # Each attack has progress 0->1 travel, then combat
    # Duration: base 1.5 + distance/600*2.5  * speed factor? Speed increases progress
    still=[]
    for atk in game["attacks"]:
        src = game["territories"].get(atk["sourceId"])
        tgt = game["territories"].get(atk["targetId"])
        if not src or not tgt:
            continue
        # if target already owned by attacker and no defender, just move troops? Capture neutral
        dist = math.hypot(src["x"]-tgt["x"], src["y"]-tgt["y"])
        # terrain slows attack
        terrain_move = TERRAIN_MODS.get(tgt["terrain"], {"move":1.0})["move"]
        defense_slow = 1 + tgt["buildings"].get("defense",0)*0.18
        base_time = (1.35 + dist/520*2.1) / terrain_move * defense_slow
        # naval slightly slower due to loading
        if atk.get("isNaval"):
            base_time *= 1.15
        atk["progress"] += dt / base_time
        if atk["progress"] >= 1.0:
            # resolve combat
            resolve_attack(game, atk, src, tgt)
        else:
            still.append(atk)
    game["attacks"]=still

    # Ships (naval transports) - we treat same as attacks but with ship visual; currently same list

    # AI tick every 15 ticks (1.5 sec)
    if game["tick"] % 15 == 0:
        for pid, pl in list(game["players"].items()):
            if pl.get("isBot") and pl["alive"] and not pl.get("eliminated"):
                ai_act(game, pl)

    # Victory check every 5 ticks for responsive leaderboard
    if game["tick"] % 5 ==0:
        check_victory(game, lobby)
        recalc_player_stats(game)
        # Check elimination
        for pid, pl in game["players"].items():
            if pl["territories"]==0 and pl["alive"]:
                # if no territories but maybe has attacks outgoing? Still alive until no troops? For now eliminate if 0 terr and no attacks
                has_attack = any(a["attackerId"]==pid for a in game["attacks"])
                if not has_attack:
                    pl["alive"]=False
                    pl["eliminated"]=True
                    push_event(game, {"type":"elim","message":f"{pl['name']} has been eliminated!","playerId":pid})

def resolve_attack(game, atk, src, tgt):
    attacker = game["players"].get(atk["attackerId"])
    if not attacker or not attacker["alive"]:
        return
    defenderId = tgt["ownerId"]
    defender = game["players"].get(defenderId) if defenderId else None
    # If allied, cancel? shouldn't happen validation prevented
    if defender and defenderId in attacker.get("allies",set()):
        # return troops to source? just return half?
        src["troops"] += atk["troops"]*0.5
        push_event(game, {"type":"info","message":f"Attack cancelled - {tgt['name']} is allied","territoryId":tgt["id"]})
        return
    # Encirclement: if all non-water neighbors are attacker/ally, defender surrenders with minimal losses
    encircled=False
    if tgt["ownerId"] is not None:
        non_water_nbrs = [nb for nb in tgt["neighbors"] if not game["territories"].get(nb,{}).get("isWater")]
        if non_water_nbrs and all(game["territories"][nb].get("ownerId")==attacker["id"] or game["territories"][nb].get("ownerId") in attacker.get("allies",set()) for nb in non_water_nbrs):
            encircled=True

    atkTroops = atk["troops"]
    defTroops = tgt["troops"]
    # terrain defense
    terrain_def = TERRAIN_MODS.get(tgt["terrain"], {"defense":0})["defense"]
    defense_build = tgt["buildings"].get("defense",0)*0.45
    # defender effective
    def_eff = defTroops * (1 + terrain_def + defense_build)
    # 2:1 bonus: if attack has >2x defender, losses flatten and attack becomes very efficient (OpenFront-style)
    ratio = atkTroops / max(1,defTroops)
    if ratio>2:
        # beyond 2:1, attacker efficiency high, defender losses huge
        atk_eff = atkTroops * (1.12 + min(0.08, (ratio-2)*0.02))
        def_eff *= 0.92
    elif encircled:
        atk_eff = atkTroops * 1.4
        def_eff *= 0.6
    else:
        atk_eff = atkTroops * 1.05
    # If target is neutral with low troops, easier
    is_neutral = defender is None
    if is_neutral:
        def_eff *= 0.82

    # Combat outcome
    # Capture if atk_eff > def_eff
    # Encircled capture is always success even if slightly outnumbered
    will_capture = atk_eff > def_eff or (encircled and atkTroops > defTroops*0.6)
    if will_capture:
        if encircled:
            # minimal losses, occupy with most troops
            occupy = max(40, int(atkTroops * 0.85))
            push_event(game, {"type":"capture","message":f"⭕ {attacker['name']} encircled and captured {tgt['name']}!","territoryId":tgt["id"],"playerId":attacker["id"],"success":True,"important":True})
        else:
            remaining = atk_eff - def_eff
            # Need to decide remaining troops that occupy territory: at least 20% of initial or remaining capped
            occupy = max(30, int(remaining * 0.62))
            # Enforce 2:1 bonus reduces attacker losses
            if ratio>2:
                occupy = max(occupy, int(atkTroops*0.55))
        # Limit to not exceed cap
        prev_owner = tgt["ownerId"]
        tgt["ownerId"] = attacker["id"]
        tgt["troops"] = min(3000, occupy)
        # Defender buildings? Keep but defense post gets damaged
        # If defender had defense, reduce it chance
        if tgt["buildings"]["defense"]>0 and random.random()<0.4:
            tgt["buildings"]["defense"] = max(0, tgt["buildings"]["defense"]-1)
        # Source already deducted, no further
        # Event (encircled already announced, skip duplicate)
        if encircled:
            pass
        elif is_neutral:
            push_event(game, {"type":"capture","message":f"{attacker['name']} captured {tgt['name']}","territoryId":tgt["id"],"playerId":attacker["id"],"success":True})
        else:
            push_event(game, {"type":"capture","message":f"{attacker['name']} conquered {tgt['name']} from {defender['name']}!","territoryId":tgt["id"],"playerId":attacker["id"],"success":True})
        # Check if defender lost all territories?
        # will be handled next recalc
    else:
        # Attack failed, defender loses some troops proportional
        loss_def = atk_eff * 0.7
        remaining_def = max(5, int(defTroops - loss_def))
        tgt["troops"] = remaining_def
        # attacker troops lost, no return
        push_event(game, {"type":"battle","message":f"{attacker['name']}'s attack on {tgt['name']} was repelled","territoryId":tgt["id"],"playerId":attacker["id"],"success":False})
        # small defender defense building xp? ignore

def ai_act(game, bot):
    # Personality influences thresholds
    personality = bot.get("personality","balanced")
    diff = DIFFICULTY.get(bot.get("botDifficulty","medium"), DIFFICULTY["medium"])
    smart = diff["smart"]
    # Gather owned territories
    owned = [t for t in game["territories"].values() if t["ownerId"]==bot["id"] and t["troops"]>40]
    if not owned:
        return
    # Economy: build?
    # Priorities per personality
    # Economic: prioritize city/factory
    # Defensive: defense posts
    # Naval: ports
    # Aggressive: minimal building, attack more
    build_choice=None
    # Try to build if gold enough
    # Find best territory to build
    if bot["gold"]>90:
        # decide building type
        candidates=[]
        if personality=="economic":
            if bot["gold"]>120 and random.random()<0.7:
                candidates=["city","factory"]
            else:
                candidates=["city"]
        elif personality=="defensive":
            candidates=["defense","city"]
        elif personality=="naval":
            candidates=["port","city"]
        elif personality=="aggressive":
            candidates=["factory","city"] if random.random()<0.4 else []
        else:
            candidates=["city","factory","port","defense"]
        if candidates:
            btype = random.choice(candidates)
            # filter cost
            cost = BUILDING_DEFS[btype]["cost"]
            if bot["gold"]>=cost:
                # find owned territory that can build it and doesn't already have high level
                possible=[]
                for t in owned:
                    if t["buildings"][btype]>=3:
                        continue
                    if btype=="port" and not t["coastal"]:
                        continue
                    if btype=="port" and t["isWater"]:
                        continue
                    # Already constructing there?
                    if any(c["territoryId"]==t["id"] for c in game["constructions"]):
                        continue
                    # Prefer frontline? For defense, border territories
                    # Score territory
                    score = random.random()
                    # Prefer higher troops location for city/factory
                    if btype in ("city","factory"):
                        score += t["troops"]/1000
                    if btype=="defense":
                        # border with enemy
                        is_border = any(game["territories"][nb]["ownerId"] != bot["id"] for nb in t["neighbors"] if nb in game["territories"])
                        if is_border:
                            score+=1
                    if btype=="port" and t["coastal"]:
                        score+=1.5
                    possible.append((score,t))
                if possible:
                    possible.sort(key=lambda x: -x[0])
                    target = possible[0][1]
                    # Build
                    if try_build(game, bot["id"], target["id"], btype, is_ai=True):
                        return # one action per tick

    # Attack logic
    # Find border territories with enemy/neutral neighbors
    # Evaluate each possible attack
    best_attack=None
    best_score=-999
    for src in owned:
        if src["troops"] < 80:
            continue
        for nb_id in src["neighbors"]:
            tgt = game["territories"].get(nb_id)
            if not tgt or tgt["isWater"]:
                continue
            if tgt["ownerId"]==bot["id"]:
                continue
            # check alliance
            if tgt["ownerId"] and tgt["ownerId"] in bot.get("allies",set()):
                continue
            # Naval if not neighbor but coastal? For AI we stick to neighbor adjacency for now; but if personality naval and both coastal with port, allow distance attack
            # Evaluate target value
            defender_troops = tgt["troops"]
            # skip if heavily defended and we are outnumbered and smart high
            ratio_needed = defender_troops / max(1, src["troops"])
            # Compute score
            is_neutral = tgt["ownerId"] is None
            is_enemy = not is_neutral
            score = 0
            if is_neutral:
                score = 10 - defender_troops/50 + random.random()*3
                # Prefer coastal if naval personality
                if tgt["coastal"] and personality=="naval":
                    score+=5
            else:
                # enemy territory
                enemy_player = game["players"].get(tgt["ownerId"])
                enemy_terr_count = enemy_player["territories"] if enemy_player else 0
                # Prefer weak enemies
                score = 8 - defender_troops/60 - enemy_terr_count/10
                # Terrain penalty
                if tgt["terrain"]=="mountain":
                    score-=3
                if tgt["buildings"]["defense"]>0:
                    score-=2 * tgt["buildings"]["defense"]
                # Personality adjustments
                if personality=="aggressive":
                    score+=3
                if personality=="defensive" and not is_neutral and defender_troops>src["troops"]*0.6:
                    score-=5
                if personality=="economic" and enemy_terr_count> bot["territories"]:
                    score-=2 # avoid strong
            # Overextension penalty: if src is border and leaving too few defenders
            # Use smart factor to avoid suicidal
            if src["troops"] - defender_troops*1.2 < 30 and smart>0.6:
                score-=5
            # Randomness based on difficulty: easy more random mistakes
            score += random.uniform(-2,2)*(1-smart+0.3)
            if score>best_score:
                best_score=score
                best_attack=(src,tgt,score)
    # Also consider naval long-range if naval personality and has port
    if personality=="naval" and best_score < 5:
        # find port owners
        port_terrs = [t for t in owned if t["buildings"]["port"]>0]
        if port_terrs:
            src = random.choice(port_terrs)
            coastal_targets = [t for t in game["territories"].values() if t["coastal"] and t["ownerId"]!=bot["id"] and t["ownerId"] not in bot.get("allies",set()) and not t["isWater"] and t["id"]!=src["id"]]
            if coastal_targets:
                # pick weakest coastal
                coastal_targets.sort(key=lambda t: t["troops"])
                tgt = coastal_targets[0]
                # naval distance check: allow if different region
                dist = math.hypot(src["x"]-tgt["x"], src["y"]-tgt["y"])
                if dist>120: # ensure sea crossing
                    best_attack=(src,tgt,6)

    if best_attack and best_attack[2] > (2 if personality!="defensive" else 4):
        src,tgt,_ = best_attack
        # Determine ratio: aggressive uses high ratio, defensive low, economic medium
        if personality=="aggressive":
            ratio=0.7 + random.random()*0.25
        elif personality=="defensive":
            ratio=0.4 + random.random()*0.2
        elif personality=="economic":
            ratio=0.5
        else:
            ratio=0.55
        # Adjust if difficult low: sometimes use too low or too high poorly
        if diff["smart"]<0.5 and random.random()<0.2:
            ratio= random.choice([0.2,0.95])
        # Cap ratio to leave defense
        # Ensure src retains at least 25 troops
        max_commit = src["troops"] - 25
        if max_commit<=20:
            return
        commit_ratio = min(ratio, max_commit/src["troops"])
        if commit_ratio<0.15:
            return
        try_attack(game, bot["id"], src["id"], tgt["id"], commit_ratio, is_ai=True)

    # Diplomacy AI: occasional alliance requests if not aggressive
    if personality!="aggressive" and random.random()<0.005:
        # find neighbor player not allied and not too strong
        candidates = [p for p in game["players"].values() if p["id"]!=bot["id"] and not p.get("isBot") or (p.get("isBot") and p["id"]!=bot["id"])]
        # filter not already allied
        candidates = [p for p in candidates if p["id"] not in bot.get("allies",set()) and p["alive"]]
        if candidates:
            target = random.choice(candidates)
            # request alliance if both medium size
            if abs(target["territories"]-bot["territories"])<4:
                # send request via event
                push_event(game, {"type":"diplomacy","message":f"{bot['name']} wants alliance with {target['name']}","from":bot["id"],"to":target["id"],"action":"request"})
                # For AI to AI auto accept if balanced?
                if target.get("isBot") and random.random()<0.6:
                    # accept
                    bot["allies"].add(target["id"])
                    target["allies"].add(bot["id"])
                    push_event(game, {"type":"diplomacy","message":f"{target['name']} allied with {bot['name']}","action":"accept","important":True})

def record_win(winner_id, game):
    try:
        p = game["players"].get(winner_id)
        if not p or p.get("isBot"):
            return
        entry = next((x for x in leaderboard if x["name"]==p["name"]), None)
        if entry:
            entry["wins"]+=1
            entry["bestTerr"]=max(entry["bestTerr"], p["territories"])
        else:
            leaderboard.append({"name":p["name"],"wins":1,"bestTerr":p["territories"],"last":"now"})
        # keep top 20
        leaderboard.sort(key=lambda x: -x["wins"])
        if len(leaderboard)>20:
            leaderboard.pop()
    except Exception as e:
        print("leaderboard err",e)

def check_victory(game, lobby):
    total_land = sum(1 for t in game["territories"].values() if not t["isWater"])
    if total_land==0:
        return
    # Domination threshold from settings or 60%
    thresh = int(game["settings"].get("victoryPercent",60))
    mode = game["settings"].get("victoryCondition","domination")
    # Timed mode: check timer
    timer = int(game["settings"].get("matchTimer",0)) # 0 means no timer, else minutes
    elapsed = time.time() - game["startedAt"]
    if timer>0 and elapsed > timer*60:
        # find highest territory %
        best=None
        best_pct=-1
        for p in game["players"].values():
            if not p["alive"]:
                continue
            pct = p["territories"]/total_land*100 if total_land else 0
            if pct>best_pct:
                best_pct=pct
                best=p
        if best:
            game["winner"]=best["id"]
            game["state"]="finished"
            lobby["state"]="finished"
            push_event(game, {"type":"victory","message":f"{best['name']} wins by score! {best_pct:.1f}%","winner":best["id"],"important":True})
            record_win(best["id"], game)
        return
    if mode in ("domination","territory"):
        for pid, pl in game["players"].items():
            if not pl["alive"]:
                continue
            pct = pl["territories"]/total_land*100 if total_land else 0
            if pct >= thresh:
                game["winner"]=pid
                game["state"]="finished"
                lobby["state"]="finished"
                push_event(game, {"type":"victory","message":f"{pl['name']} achieved domination! {pct:.1f}%","winner":pid,"important":True})
                record_win(pid, game)
                return
    elif mode=="elimination":
        alive_players = [p for p in game["players"].values() if p["alive"] and p["territories"]>0]
        if len(alive_players)==1:
            winner=alive_players[0]
            game["winner"]=winner["id"]
            game["state"]="finished"
            lobby["state"]="finished"
            push_event(game, {"type":"victory","message":f"{winner['name']} eliminated all opponents!","winner":winner["id"],"important":True})
            record_win(winner["id"], game)
    # Economic victory? Highest gold? treat as timed
    # Also elimination check handled elsewhere

def try_build(game, playerId, territoryId, building, is_ai=False):
    terr = game["territories"].get(territoryId)
    pl = game["players"].get(playerId)
    if not terr or not pl:
        return False
    if terr["ownerId"]!=playerId:
        if not is_ai:
            push_event(game, {"type":"error","message":"You don't own this territory","playerId":playerId})
        return False
    if terr["isWater"]:
        return False
    if building not in BUILDING_DEFS:
        return False
    bdef = BUILDING_DEFS[building]
    if bdef.get("requires_coastal") and not terr["coastal"]:
        if not is_ai:
            push_event(game, {"type":"error","message":"Port requires coastal territory","playerId":playerId})
        return False
    if terr["buildings"][building]>=3:
        if not is_ai:
            push_event(game, {"type":"error","message":"Max level reached","playerId":playerId})
        return False
    if any(c["territoryId"]==territoryId for c in game["constructions"]):
        if not is_ai:
            push_event(game, {"type":"error","message":"Already constructing there","playerId":playerId})
        return False
    cost = bdef["cost"] * (1 + terr["buildings"][building]*0.6)
    cost=int(cost)
    if pl["gold"] < cost:
        if not is_ai:
            push_event(game, {"type":"error","message":f"Need {cost} gold","playerId":playerId})
        return False
    # special: silo requires? ignore
    pl["gold"] -= cost
    game["constructions"].append({"id":gen_id(),"territoryId":territoryId,"building":building,"progress":0.0,"ownerId":playerId})
    push_event(game, {"type":"build_start","message":f"{pl['name']} building {bdef['name']} in {terr['name']}","territoryId":territoryId,"playerId":playerId})
    return True

def try_attack(game, attackerId, sourceId, targetId, ratio, is_ai=False):
    src = game["territories"].get(sourceId)
    tgt = game["territories"].get(targetId)
    attacker = game["players"].get(attackerId)
    if not src or not tgt or not attacker:
        return False, "Invalid territory"
    if src["ownerId"]!=attackerId:
        return False, "You don't own source"
    if tgt["isWater"]:
        return False, "Cannot attack water"
    if src["id"]==tgt["id"]:
        return False, "Same territory"
    # check alliance
    if tgt["ownerId"] and tgt["ownerId"] in attacker.get("allies",set()):
        return False, "Cannot attack ally - break alliance first"
    # check adjacency or naval
    is_neighbor = targetId in src["neighbors"]
    is_naval = False
    if not is_neighbor:
        # naval allowed if source has port and both coastal
        if src["coastal"] and tgt["coastal"] and src["buildings"].get("port",0)>0:
            # allow if distance >? consider naval route
            is_naval=True
        else:
            return False, "Not reachable - need adjacency or Port for naval"
    # validate troops
    if src["troops"] < 30:
        return False, "Not enough troops in source (need 30)"
    # ratio clamp 0.1-0.95
    ratio = max(0.1, min(0.95, float(ratio)))
    troops_commit = int(src["troops"] * ratio)
    if troops_commit < 10:
        return False, "Commit too few troops"
    if src["troops"] - troops_commit < 15:
        # leave at least 15
        troops_commit = int(src["troops"] - 15)
        if troops_commit<10:
            return False, "Would leave source defenseless"
    # reinforce check: if already attacking same target from same source, reinforce
    for atk in game["attacks"]:
        if atk["attackerId"]==attackerId and atk["sourceId"]==sourceId and atk["targetId"]==targetId:
            # reinforce
            atk["troops"] += troops_commit
            src["troops"] -= troops_commit
            push_event(game, {"type":"reinforce","message":f"{attacker['name']} reinforced attack on {tgt['name']} (+{troops_commit})","territoryId":targetId,"playerId":attackerId})
            return True, "Reinforced"
    # deduct
    src["troops"] -= troops_commit
    # create attack
    atk = {
        "id": gen_id(),
        "attackerId": attackerId,
        "sourceId": sourceId,
        "targetId": targetId,
        "troops": troops_commit,
        "progress": 0.0,
        "isNaval": is_naval,
        "startTime": time.time(),
    }
    game["attacks"].append(atk)
    # cost gold small for attack? optional 5 gold
    # attacker gold not deducted, but we could: 
    # Push event
    if is_naval:
        push_event(game, {"type":"naval","message":f"{attacker['name']} launched naval assault on {tgt['name']}","territoryId":targetId,"playerId":attackerId})
    else:
        push_event(game, {"type":"attack","message":f"{attacker['name']} attacks {tgt['name']}","territoryId":targetId,"playerId":attackerId})
    return True, "Attack launched"

def try_missile(game, playerId, targetId):
    pl = game["players"].get(playerId)
    tgt = game["territories"].get(targetId)
    if not pl or not tgt:
        return False, "Invalid"
    # Check silo
    has_silo = any(t["ownerId"]==playerId and t["buildings"].get("silo",0)>0 for t in game["territories"].values())
    if not has_silo:
        return False, "Need Spectre Silo"
    # cooldown
    cool = game["missile_cooldowns"].get(playerId,0)
    if time.time() - cool < 45:
        return False, f"Missile cooldown {int(45 - (time.time()-cool))}s"
    if pl["gold"] < 300:
        return False, "Need 300 gold"
    # check superweapons enabled in settings
    if not game["settings"].get("superweapons", True):
        return False, "Superweapons disabled"
    pl["gold"]-=300
    game["missile_cooldowns"][playerId]=time.time()
    # Warning event
    push_event(game, {"type":"missile_warning","message":f"⚠️ STRATEGIC MISSILE inbound on {tgt['name']}! Impact in 5s","territoryId":targetId,"playerId":playerId,"important":True})
    # Schedule impact after 5 sec
    async def impact():
        await asyncio.sleep(5)
        # apply damage if game still playing
        if game["state"]!="playing":
            return
        # Damage target and neighbors
        affected = [tgt["id"]] + tgt["neighbors"][:3]
        for tid in affected:
            ter = game["territories"].get(tid)
            if ter:
                ter["troops"] = max(5, int(ter["troops"]*0.45))
                # damage buildings
                if ter["buildings"]["defense"]>0 and random.random()<0.7:
                    ter["buildings"]["defense"]=max(0, ter["buildings"]["defense"]-1)
                if ter["buildings"]["city"]>0 and random.random()<0.3:
                    ter["buildings"]["city"]=max(0, ter["buildings"]["city"]-1)
        push_event(game, {"type":"missile_impact","message":f"💥 Missile struck {tgt['name']}! Troops devastated","territoryId":tgt["id"],"playerId":playerId,"important":True})
    asyncio.create_task(impact())
    return True, "Missile launched"

# Lobby management
def create_lobby(name, mapId, settings, hostId, hostName):
    lid = gen_id()
    lobby = {
        "id": lid,
        "name": name or f"Lobby {lid[:4]}",
        "mapId": mapId if mapId in maps_data else "world",
        "settings": {
            "startingGold": int(settings.get("startingGold",500)),
            "startingTroops": int(settings.get("startingTroops",500)),
            "gameSpeed": float(settings.get("gameSpeed",1.0)),
            "economicSpeed": float(settings.get("economicSpeed",1.0)),
            "victoryCondition": settings.get("victoryCondition","domination"),
            "victoryPercent": int(settings.get("victoryPercent",60)),
            "matchTimer": int(settings.get("matchTimer",0)),
            "maxPlayers": int(settings.get("maxPlayers",8)),
            "fogOfWar": bool(settings.get("fogOfWar",False)),
            "diplomacy": bool(settings.get("diplomacy",True)),
            "naval": bool(settings.get("naval",True)),
            "buildings": bool(settings.get("buildings",True)),
            "superweapons": bool(settings.get("superweapons",True)),
        },
        "hostId": hostId,
        "players": [],
        "state": "waiting", # waiting, countdown, playing, finished
        "game": None,
        "createdAt": time.time(),
        "private": bool(settings.get("private",False)),
    }
    # Add host player
    color = random.choice(COLORS)
    lobby["players"].append({"id":hostId,"name":hostName,"color":color,"ready":True,"isBot":False})
    lobbies[lid]=lobby
    player_to_lobby[hostId]=lid
    return lobby

def add_bot_to_lobby(lobby, difficulty="medium", personality="balanced"):
    bid = "bot_"+gen_id()
    color = random.choice([c for c in COLORS if c not in [p["color"] for p in lobby["players"]]] ) or random.choice(COLORS)
    name = f"Bot {random.choice(['Ares','Athena','Zeus','Khan','Napoleon','Caesar','Genghis','Alexander','Hannibal','Sparta'])} {bid[:2]}"
    lobby["players"].append({"id":bid,"name":name,"color":color,"ready":True,"isBot":True,"botDifficulty":difficulty,"personality":personality})

def lobby_summary(l):
    return {
        "id": l["id"],
        "name": l["name"],
        "mapId": l["mapId"],
        "mapName": maps_data.get(l["mapId"],{}).get("name",l["mapId"]),
        "players": len(l["players"]),
        "maxPlayers": l["settings"]["maxPlayers"],
        "state": l["state"],
        "hostId": l["hostId"],
        "private": l["private"],
    }

def serialize_game_for_player(game, playerId):
    # Fog of war handling: if enabled, hide distant info
    fog = game["settings"].get("fogOfWar", False)
    # For now simple: if fog, only show owned + neighbors + nearby? But we keep simple: hide defender gold/troops if not visible
    # We'll include all but mark fogged territories
    terrs_out={}
    player_terr_ids=set(t["id"] for t in game["territories"].values() if t["ownerId"]==playerId)
    visible=set(player_terr_ids)
    if fog:
        for tid in list(player_terr_ids):
            t = game["territories"][tid]
            for nb in t["neighbors"]:
                visible.add(nb)
    else:
        visible=set(game["territories"].keys())
    for tid, t in game["territories"].items():
        is_visible = tid in visible or not fog
        out = dict(t)
        if fog and not is_visible:
            # hide owner? keep geography but hide troops owner slightly? We'll hide owner troops as ?
            out["ownerId"]=None
            out["troops"]=0
            out["buildings"]={"city":0,"factory":0,"port":0,"defense":0,"silo":0}
        terrs_out[tid]=out
    # players out
    players_out={}
    for pid,p in game["players"].items():
        po=dict(p)
        # convert set to list
        if "allies" in po and isinstance(po["allies"], set):
            po["allies"]=list(po["allies"])
        players_out[pid]=po
    # attacks out
    attacks_out=list(game["attacks"])
    constructions_out=list(game["constructions"])
    events_out= game["events"][-30:] # last 30
    return {
        "lobbyId": game["lobbyId"],
        "mapId": game["mapId"],
        "mapName": game["mapName"],
        "width": game["width"],
        "height": game["height"],
        "territories": terrs_out,
        "players": players_out,
        "attacks": attacks_out,
        "constructions": constructions_out,
        "events": events_out,
        "tick": game["tick"],
        "state": game["state"],
        "countdown": game.get("countdown",0),
        "winner": game.get("winner"),
        "settings": game["settings"],
    }

def serialize_lobby(lobby):
    # for lobby screen
    return {
        "id": lobby["id"],
        "name": lobby["name"],
        "mapId": lobby["mapId"],
        "mapName": maps_data.get(lobby["mapId"],{}).get("name", lobby["mapId"]),
        "settings": lobby["settings"],
        "players": lobby["players"],
        "hostId": lobby["hostId"],
        "state": lobby["state"],
        "game": serialize_game_for_player(lobby["game"], lobby["hostId"]) if lobby["game"] else None
    }

# FastAPI routes
@app.get("/api/maps")
async def api_maps():
    return [{"id":k,"name":v["name"],"territories":len(v["territories"])} for k,v in maps_data.items()]

@app.get("/api/lobbies")
async def api_lobbies():
    return [lobby_summary(l) for l in lobbies.values() if not l["private"]]

@app.get("/api/leaderboard")
async def api_leaderboard():
    # return online leaderboard (wins) sorted
    return sorted(leaderboard, key=lambda x: -x["wins"])[:20]

@app.get("/")
async def root():
    return FileResponse(STATIC_DIR / "index.html")

# WebSocket
@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    await ws.accept()
    player_id = gen_id()
    connections[player_id]=ws
    # Send connected
    await ws.send_json({"type":"connected","playerId":player_id, "maps": [{"id":k,"name":v["name"]} for k,v in maps_data.items()]})
    try:
        while True:
            data = await ws.receive_text()
            try:
                msg=json.loads(data)
            except:
                continue
            typ=msg.get("type")
            # CREATE LOBBY
            if typ=="create_lobby":
                name=msg.get("name","")
                mapId=msg.get("mapId","world")
                settings=msg.get("settings",{})
                playerName=msg.get("playerName") or f"Player {player_id[:4]}"
                player_names[player_id]=playerName
                # remove previous lobby if any
                old_lid=player_to_lobby.get(player_id)
                if old_lid and old_lid in lobbies:
                    l = lobbies[old_lid]
                    l["players"]=[p for p in l["players"] if p["id"]!=player_id]
                    if not l["players"]:
                        lobbies.pop(old_lid,None)
                lobby=create_lobby(name, mapId, settings, player_id, playerName)
                # add bots if requested
                botCount=int(settings.get("botCount",2))
                botDiff=settings.get("botDifficulty","medium")
                for i in range(botCount):
                    pers=random.choice(PERSONALITIES)
                    add_bot_to_lobby(lobby,botDiff,pers)
                await ws.send_json({"type":"lobby_update","lobby": serialize_lobby(lobby)})
                # broadcast to others? no others yet
                # also send lobby list update to all
                await broadcast_lobbies()

            elif typ=="join_lobby":
                lobbyId=msg.get("lobbyId")
                playerName=msg.get("playerName") or f"Player {player_id[:4]}"
                player_names[player_id]=playerName
                lobby=lobbies.get(lobbyId)
                if not lobby:
                    await ws.send_json({"type":"error","message":"Lobby not found"})
                    continue
                if lobby["state"]!="waiting":
                    await ws.send_json({"type":"error","message":"Game already started"})
                    continue
                if len(lobby["players"])>=lobby["settings"]["maxPlayers"]:
                    await ws.send_json({"type":"error","message":"Lobby full"})
                    continue
                # remove from old lobby
                old_lid=player_to_lobby.get(player_id)
                if old_lid and old_lid in lobbies and old_lid!=lobbyId:
                    old=lobbies[old_lid]
                    old["players"]=[p for p in old["players"] if p["id"]!=player_id]
                    if not old["players"]:
                        lobbies.pop(old_lid,None)
                    else:
                        if old["hostId"]==player_id:
                            old["hostId"]=old["players"][0]["id"]
                        await broadcast_to_lobby(old_lid)
                # add to new
                if not any(p["id"]==player_id for p in lobby["players"]):
                    color = random.choice([c for c in COLORS if c not in [p["color"] for p in lobby["players"]]] ) or random.choice(COLORS)
                    lobby["players"].append({"id":player_id,"name":playerName,"color":color,"ready":False,"isBot":False})
                player_to_lobby[player_id]=lobbyId
                await broadcast_to_lobby(lobbyId)
                await ws.send_json({"type":"joined","lobbyId":lobbyId})
                await broadcast_lobbies()

            elif typ=="leave_lobby":
                lid=player_to_lobby.get(player_id)
                if lid and lid in lobbies:
                    lobby=lobbies[lid]
                    lobby["players"]=[p for p in lobby["players"] if p["id"]!=player_id]
                    if not lobby["players"]:
                        # remove lobby; if game exists keep? remove
                        lobbies.pop(lid,None)
                    else:
                        if lobby["hostId"]==player_id:
                            # new host first non-bot or first player
                            non_bot=[p for p in lobby["players"] if not p.get("isBot")]
                            lobby["hostId"]=(non_bot[0]["id"] if non_bot else lobby["players"][0]["id"])
                        await broadcast_to_lobby(lid)
                    player_to_lobby.pop(player_id,None)
                    await ws.send_json({"type":"left"})
                    await broadcast_lobbies()

            elif typ=="set_ready":
                ready=bool(msg.get("ready",True))
                lid=player_to_lobby.get(player_id)
                if lid and lid in lobbies:
                    lobby=lobbies[lid]
                    for p in lobby["players"]:
                        if p["id"]==player_id:
                            p["ready"]=ready
                    await broadcast_to_lobby(lid)

            elif typ=="update_settings":
                settings=msg.get("settings",{})
                lid=player_to_lobby.get(player_id)
                if lid and lid in lobbies:
                    lobby=lobbies[lid]
                    if lobby["hostId"]!=player_id:
                        await ws.send_json({"type":"error","message":"Only host can change settings"})
                        continue
                    if lobby["state"]!="waiting":
                        await ws.send_json({"type":"error","message":"Cannot change after start"})
                        continue
                    # update allowed settings
                    for k,v in settings.items():
                        if k in lobby["settings"]:
                            lobby["settings"][k]=v
                    # map change
                    if "mapId" in msg and msg["mapId"] in maps_data:
                        lobby["mapId"]=msg["mapId"]
                    # bot count change handling: if botCount increased, add bots; if decreased, remove bots
                    if "botCount" in settings:
                        desired=int(settings["botCount"])
                        current_bots=len([p for p in lobby["players"] if p.get("isBot")])
                        if desired>current_bots:
                            for i in range(desired-current_bots):
                                add_bot_to_lobby(lobby, lobby["settings"].get("botDifficulty","medium") if "botDifficulty" not in settings else settings["botDifficulty"], random.choice(PERSONALITIES))
                        elif desired<current_bots:
                            # remove bots
                            bots=[p for p in lobby["players"] if p.get("isBot")]
                            to_remove=bots[desired:]
                            for b in to_remove:
                                lobby["players"].remove(b)
                    if "botDifficulty" in settings:
                        for p in lobby["players"]:
                            if p.get("isBot"):
                                p["botDifficulty"]=settings["botDifficulty"]
                    await broadcast_to_lobby(lid)
                    await broadcast_lobbies()

            elif typ=="start_game":
                lid=player_to_lobby.get(player_id)
                if lid and lid in lobbies:
                    lobby=lobbies[lid]
                    if lobby["hostId"]!=player_id:
                        await ws.send_json({"type":"error","message":"Only host can start"})
                        continue
                    if lobby["state"]!="waiting":
                        await ws.send_json({"type":"error","message":"Already started"})
                        continue
                    # Need at least 2 players? allow 1 + bots
                    if len(lobby["players"])<2:
                        await ws.send_json({"type":"error","message":"Need at least 2 players/bots"})
                        continue
                    # create game
                    new_game(lobby)
                    await broadcast_to_lobby(lid)
                    await broadcast_lobbies()

            elif typ=="attack":
                lid=player_to_lobby.get(player_id)
                if lid and lid in lobbies:
                    lobby=lobbies[lid]
                    game=lobby.get("game")
                    if not game or game["state"]!="playing":
                        await ws.send_json({"type":"error","message":"Game not playing"})
                        continue
                    src=msg.get("sourceId")
                    tgt=msg.get("targetId")
                    ratio=msg.get("ratio",0.5)
                    ok,m=try_attack(game, player_id, src, tgt, ratio)
                    if not ok:
                        await ws.send_json({"type":"error","message":m})
                    # broadcast will happen in tick loop, but send immediate update
                    await broadcast_game(lid)

            elif typ=="build":
                lid=player_to_lobby.get(player_id)
                if lid and lid in lobbies:
                    lobby=lobbies[lid]
                    game=lobby.get("game")
                    if not game or game["state"]!="playing":
                        await ws.send_json({"type":"error","message":"Game not playing"})
                        continue
                    terr=msg.get("territoryId")
                    building=msg.get("building")
                    if not try_build(game, player_id, terr, building):
                        # error already pushed as event; also send error
                        pass
                    await broadcast_game(lid)

            elif typ=="upgrade":
                # same as build (building level increments)
                lid=player_to_lobby.get(player_id)
                if lid and lid in lobbies:
                    lobby=lobbies[lid]
                    game=lobby.get("game")
                    if not game or game["state"]!="playing":
                        continue
                    terr=msg.get("territoryId")
                    building=msg.get("building")
                    try_build(game, player_id, terr, building)
                    await broadcast_game(lid)

            elif typ=="missile":
                lid=player_to_lobby.get(player_id)
                if lid and lid in lobbies:
                    lobby=lobbies[lid]
                    game=lobby.get("game")
                    if not game or game["state"]!="playing":
                        continue
                    tgt=msg.get("targetId")
                    ok,m=try_missile(game, player_id, tgt)
                    if not ok:
                        await ws.send_json({"type":"error","message":m})
                    await broadcast_game(lid)

            elif typ=="diplomacy":
                action=msg.get("action")
                targetId=msg.get("targetId")
                lid=player_to_lobby.get(player_id)
                if lid and lid in lobbies:
                    lobby=lobbies[lid]
                    game=lobby.get("game")
                    if not game:
                        # lobby diplomacy? ignore
                        continue
                    me=game["players"].get(player_id)
                    other=game["players"].get(targetId)
                    if not me or not other:
                        continue
                    if action=="request":
                        push_event(game, {"type":"diplomacy","message":f"{me['name']} requests alliance with {other['name']}","from":player_id,"to":targetId,"action":"request"})
                    elif action=="accept":
                        me["allies"].add(targetId)
                        other["allies"].add(player_id)
                        push_event(game, {"type":"diplomacy","message":f"{me['name']} and {other['name']} are now allies!","action":"accept","important":True})
                    elif action=="reject":
                        push_event(game, {"type":"diplomacy","message":f"{me['name']} rejected alliance with {other['name']}","action":"reject"})
                    elif action=="break":
                        me["allies"].discard(targetId)
                        other["allies"].discard(player_id)
                        push_event(game, {"type":"diplomacy","message":f"{me['name']} broke alliance with {other['name']}!","action":"break","important":True})
                    await broadcast_game(lid)

            elif typ=="quick_chat":
                lid=player_to_lobby.get(player_id)
                if lid and lid in lobbies:
                    lobby=lobbies[lid]
                    game=lobby.get("game")
                    category=msg.get("category","misc")
                    text=msg.get("message","")
                    # limit length
                    text=text[:80]
                    sender=player_names.get(player_id, "Player")
                    if game:
                        push_event(game, {"type":"chat","message":f"[{category}] {sender}: {text}","playerId":player_id,"category":category})
                        await broadcast_game(lid)
                    else:
                        # lobby chat
                        await broadcast_to_lobby(lid, extra={"type":"chat","message":f"{sender}: {text}"})

            elif typ=="cancel_attack":
                # find attack by id and cancel if attacker is player
                lid=player_to_lobby.get(player_id)
                if lid and lid in lobbies:
                    lobby=lobbies[lid]
                    game=lobby.get("game")
                    if not game:
                        continue
                    aid=msg.get("attackId")
                    for atk in list(game["attacks"]):
                        if atk["id"]==aid and atk["attackerId"]==player_id:
                            # refund half troops to source
                            src=game["territories"].get(atk["sourceId"])
                            if src:
                                src["troops"]+= int(atk["troops"]*0.5)
                            game["attacks"].remove(atk)
                            push_event(game, {"type":"retreat","message":f"{game['players'][player_id]['name']} retreated attack on {game['territories'][atk['targetId']]['name']}","playerId":player_id})
                            await broadcast_game(lid)
                            break

            elif typ=="get_lobbies":
                await ws.send_json({"type":"lobbies","lobbies": [lobby_summary(l) for l in lobbies.values() if not l["private"]]})

            elif typ=="get_maps":
                await ws.send_json({"type":"maps","maps": [{"id":k,"name":v["name"]} for k,v in maps_data.items()]})

            elif typ=="ping":
                await ws.send_json({"type":"pong"})

            elif typ=="reconnect":
                oldId=msg.get("playerId")
                # try to restore mapping?
                pass

    except WebSocketDisconnect:
        pass
    finally:
        # cleanup connection but keep player in lobby for reconnect window
        connections.pop(player_id,None)
        # Don't immediately remove from lobby; keep for 60 sec to allow reconnect? For now keep
        # If lobby is waiting and player disconnect, after 10 sec remove? We keep simple: remove after disconnect if waiting
        lid=player_to_lobby.get(player_id)
        if lid and lid in lobbies:
            lobby=lobbies[lid]
            # if game is playing, keep player data for reconnect (don't remove)
            if lobby["state"]=="waiting":
                # remove after short delay? immediate for now
                # But keep bots?
                # Remove player entry
                lobby["players"]=[p for p in lobby["players"] if p["id"]!=player_id]
                if not [p for p in lobby["players"] if not p.get("isBot")]:
                    # no human left, maybe keep lobby? Remove after 30s? For now keep but if no players delete
                    if not lobby["players"]:
                        lobbies.pop(lid,None)
                    else:
                        # assign new host
                        lobby["hostId"]=lobby["players"][0]["id"]
                        await broadcast_to_lobby(lid)
                else:
                    if lobby["hostId"]==player_id:
                        non_bot=[p for p in lobby["players"] if not p.get("isBot")]
                        lobby["hostId"]= (non_bot[0]["id"] if non_bot else lobby["players"][0]["id"])
                    await broadcast_to_lobby(lid)
                player_to_lobby.pop(player_id,None)
                await broadcast_lobbies()

async def broadcast_to_lobby(lobbyId, extra=None):
    lobby=lobbies.get(lobbyId)
    if not lobby:
        return
    # send lobby_update to all players in lobby
    msg={"type":"lobby_update","lobby": serialize_lobby(lobby)}
    if extra:
        # not needed
        pass
    for p in lobby["players"]:
        pid=p["id"]
        if pid in connections:
            try:
                await connections[pid].send_json(msg)
            except:
                pass
        # also if game exists, send game_state
        if lobby.get("game"):
            await broadcast_game(lobbyId)

async def broadcast_game(lobbyId):
    lobby=lobbies.get(lobbyId)
    if not lobby or not lobby.get("game"):
        return
    game=lobby["game"]
    # send to each player individualized (fog)
    for p in lobby["players"]:
        pid=p["id"]
        if pid in connections:
            try:
                state=serialize_game_for_player(game, pid)
                await connections[pid].send_json({"type":"game_state","state":state})
            except:
                pass
    # also consider bots don't need connection

async def broadcast_lobbies():
    # send lobbies list to all waiting connections not in game?
    lobbies_list=[lobby_summary(l) for l in lobbies.values() if not l["private"]]
    for pid, ws in list(connections.items()):
        # only send if player not in playing game?
        lid=player_to_lobby.get(pid)
        lobby=lobbies.get(lid) if lid else None
        if not lobby or lobby["state"]=="waiting":
            try:
                await ws.send_json({"type":"lobbies","lobbies":lobbies_list})
            except:
                pass

async def game_loop():
    while True:
        # tick each lobby's game
        for lid, lobby in list(lobbies.items()):
            if lobby.get("game"):
                try:
                    game_tick(lobby)
                except Exception as e:
                    print(f"tick error {lid}: {e}")
                    import traceback; traceback.print_exc()
                # broadcast game state periodically (every 100ms loop does broadcast)
                # Throttle broadcast to 10 Hz as well: but we can broadcast every tick
                # For playing state, broadcast to lobby
                if lobby["game"]["state"] in ("playing","countdown","finished"):
                    # broadcast every tick for smooth
                    await broadcast_game(lid)
                    # Also broadcast lobbies periodically if finished?
        await asyncio.sleep(0.1)

@app.on_event("startup")
async def startup_event():
    asyncio.create_task(game_loop())

# Static files mounting must be last to not override API
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

@app.get("/health")
async def health():
    return {"status":"ok","maps":len(maps_data),"lobbies":len(lobbies)}

# Ensure index.html served at /static fallback? root already serves index
# Also serve static index for any unknown path? Not needed

if __name__=="__main__":
    import uvicorn
    print("Starting server on 0.0.0.0:8000")
    print(f"Maps loaded: {list(maps_data.keys())}")
    uvicorn.run(app, host="0.0.0.0", port=8000)
