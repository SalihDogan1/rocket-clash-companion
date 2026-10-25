import { useState, useEffect, useRef } from 'react';
import { Rocket, Trophy, LogOut, CheckCircle2, AlertTriangle, ShieldAlert, Activity, Users, Clock, Flame } from 'lucide-react';
import { signInWithEmailAndPassword, signInWithCredential, GoogleAuthProvider, signOut } from 'firebase/auth';

import { auth } from './firebase';
import './App.css';

// Standart bot isimleri listesi (PrimaryId fallback için)
const KNOWN_BOT_NAMES = new Set([
  'saltie', 'merlin', 'heater', 'poncho', 'swagman', 'shepard', 'tex',
  'hound', 'jester', 'cougar', 'slider', 'viper', 'wolfman', 'marverick',
  'foamer', 'gerwin', 'imp', 'khan', 'raja', 'sultan', 'yuri', 'tusk',
  'samara', 'storm', 'stinger', 'centurion', 'caveman', 'boomer', 'dude',
  'armstrong', 'buzz', 'casper', 'chipper'
]);

function formatTime(seconds) {
  if (seconds === null || seconds === undefined || isNaN(seconds)) return '--:--';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

function extractGameClock(game, fallback = null) {
  if (game === null || game === undefined) return fallback ?? 0;
  if (typeof game === 'number') return game;
  if (typeof game.SecondsRemaining === 'number') return game.SecondsRemaining;
  if (typeof game.seconds_remaining === 'number') return game.seconds_remaining;
  if (typeof game.TimeSeconds === 'number') return game.TimeSeconds;
  if (typeof game.time_seconds === 'number') return game.time_seconds;
  if (typeof game.Seconds === 'number') return game.Seconds;
  if (typeof game.seconds === 'number') return game.seconds;
  return fallback ?? 0;
}

// Tek hedef: sunucu adresi (geliştirmede companion-app/.env.local içindeki VITE_BACKEND_URL ile değiştirilir)
const BACKEND_URL = (import.meta.env.VITE_BACKEND_URL || 'https://rocket.loopesports.com').replace(/\/$/, '');

// Kimlik doğrulamalı istek. Cevabı bekler; geçici hatada (ağ/sunucu) 3 kez yeniden dener. 4xx hatası (ör. yetki) tekrar denenmez.
async function apiCall(path, method, body, { retries = 3 } = {}) {
  const delays = [2000, 5000, 10000];
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const token = await auth.currentUser?.getIdToken(attempt > 0);
      if (!token) return { ok: false, final: true, error: 'Giriş yapılmamış' };
      const res = await fetch(`${BACKEND_URL}/api${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (res.ok) return { ok: true, data: await res.json().catch(() => ({})) };
      if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
        const e = await res.json().catch(() => ({}));
        return { ok: false, final: true, status: res.status, error: e.error || `HTTP ${res.status}` };
      }
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    if (attempt < retries) await new Promise((r) => setTimeout(r, delays[attempt] ?? 10000));
  }
  return { ok: false, error: lastErr?.message || 'Bağlantı hatası' };
}

// "Maç başladı / bitti": sürekli akış yok, yalnızca bu iki küçük bildirim (yanıt beklenmez)
function sendEvent(type, matchGuid) {
  apiCall('/companion/event', 'POST', { type, matchGuid }, { retries: 1 }).catch(() => {});
}

const OUTCOME_TEXT = {
  complete: 'Gönderildi ✓ Maç sonucu sisteme işlendi.',
  pending: 'Gönderildi ✓ Sonuç yetkili onayı bekliyor.',
  telemetry_only: 'Gönderildi ✓',
  identity_unresolved: 'Gönderildi ama oyuncu kimliğin maçta eşleşmedi. Skoru yetkili girecek. "Oyun içi adım" ayarını kontrol et.',
  no_team: 'Gönderildi ama hesabın bir takıma bağlı değil.',
  no_match: 'Gönderildi ama sırada bekleyen bir turnuva maçın bulunamadı.',
};


function App() {
  const [status, setStatus] = useState('Rocket League Bekleniyor...');
  const [gameProc, setGameProc] = useState({ running: false, needsRestart: false }); // oyun açık mı (yalnızca bilgi)
  const statusText = status.includes('Bağlandı') ? status
    : gameProc.needsRestart ? "Ayar düzeltildi: Rocket League'i kapatıp yeniden aç"
    : gameProc.running ? 'Rocket League açık • özel maç bekleniyor'
    : 'Rocket League kapalı';
  const [matchData, setMatchData] = useState(null);
  const [liveState, setLiveState] = useState(null);
  const [user, setUser] = useState(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loginError, setLoginError] = useState('');
  const [googleBusy, setGoogleBusy] = useState(false);
  const [showTimeline, setShowTimeline] = useState(false);
  const [uploadState, setUploadState] = useState({ status: 'idle', message: '' });

  // Telemetri ve denetim referansları (Render tetiklemeyen iç hafıza)
  const latestGameStateRef = useRef(null);
  const timelineRef = useRef([]);
  const goalEventsRef = useRef([]);
  const prevScoresRef = useRef({ blue: 0, orange: 0 });
  const initialMatchStateRef = useRef(null);
  const matchStartTimeRef = useRef(null);
  const lastClockRef = useRef(null);
  const lastSeenPlayersRef = useRef([]);
  const sealedMatchesRef = useRef(new Set());
  const seenActiveMatchesRef = useRef(new Set());
  const clockJumpsRef = useRef([]); // { desc, diff } — büyük/küçük ayrımı maç sonunda yapılır
  // Maçı baştan sona izleyip izlemediğimiz: baştan başlamadıysak ya da arada veri kesildiyse "eksik" sayılır ve YÜKLEME YAPILMAZ
  const coverageRef = useRef({ fromStart: false, gap: false });
  const lastEventAtRef = useRef(0);
  const startedEventGuidRef = useRef('');
  const pendingUploadRef = useRef(null);
  const lastUiUpdateRef = useRef(0);
  const targetCountsRef = useRef({}); // oyunun "kamerayı takip ettiği oyuncu" sayacı = bu bilgisayarda oynayan kişi

  const handleClockUpdate = (currentSec) => {
    if (currentSec === null || currentSec === undefined || isNaN(currentSec)) return;
    if (!initialMatchStateRef.current || initialMatchStateRef.current.playlistId !== 6) return;
    if (latestGameStateRef.current?.overtime) return;

    const prev = lastClockRef.current;
    if (prev !== null && prev !== undefined) {
      const diff = prev - currentSec;
      if (diff > 4 || diff < -2) {
        const jumpDesc = `${formatTime(prev)} ➔ ${formatTime(currentSec)}`;
        if (!clockJumpsRef.current.some((j) => j.desc === jumpDesc)) {
          clockJumpsRef.current.push({ desc: jumpDesc, diff });
        }
        const lastTl = timelineRef.current[timelineRef.current.length - 1];
        if (!lastTl || lastTl.type !== 'CLOCK_JUMP' || lastTl.time !== formatTime(prev)) {
          timelineRef.current.push({
            time: formatTime(prev),
            type: 'CLOCK_JUMP',
            detail: `⏰ Oyun saati sıçradı: ${jumpDesc} (${Math.abs(diff)} sn ${diff > 0 ? 'atlatıldı' : 'geri alındı'})`,
          });
        }
      }
    }
    lastClockRef.current = currentSec;
    if (latestGameStateRef.current) {
      latestGameStateRef.current.timeSeconds = currentSec;
    }
  };

  useEffect(() => {
    const unsubscribe = auth.onAuthStateChanged(setUser);
    return () => unsubscribe();
  }, []);

  // Rocket League TCP port (Port 49123) dinleyicisi
  useEffect(() => {
    if (!window.electronAPI) return;

    const unbindStatus = window.electronAPI.onRlStatus((statusMsg) => {
      if (statusMsg === 'connected') setStatus('Rocket League Bağlandı!');
      if (statusMsg === 'disconnected') {
        setStatus('Rocket League Bekleniyor...');
        // Maç sürerken oyunla bağlantı koptuysa bu maçın kaydı EKSİK olur (yüklenmez); canlı rozetini de kapat
        if (initialMatchStateRef.current) {
          coverageRef.current.gap = true;
          if (startedEventGuidRef.current) sendEvent('ended', startedEventGuidRef.current);
        }
      }
    });

    const unbindProc = window.electronAPI.onRlProcess ? window.electronAPI.onRlProcess((p) => setGameProc(p)) : () => {};

    const unbindEvent = window.electronAPI.onRlEvent(async (payload) => {
      try {
        // Veri kesintisi tespiti: maç sürerken 8 saniyeden uzun hiçbir olay gelmediyse (ör. oyuncu maçtan çıkıp girdi) kayıt eksik sayılır
        const nowMs = Date.now();
        if (initialMatchStateRef.current && lastEventAtRef.current && nowMs - lastEventAtRef.current > 8000) {
          coverageRef.current.gap = true;
        }
        lastEventAtRef.current = nowMs;

        let eventData = payload;
        if (typeof payload.Data === 'string') {
          try {
            eventData = JSON.parse(payload.Data);
          } catch (e) {}
        }

        setStatus('Rocket League Bağlandı!');
        const rawEvent = payload?.Event || payload?.event || '';
        const eventName = String(rawEvent);

        // 0. SAAT GÜNCELLEMESİ (ClockUpdatedSeconds)
        if (eventName === 'ClockUpdatedSeconds' && eventData) {
          const clk = extractGameClock(eventData?.data ?? eventData?.Data ?? eventData, lastClockRef.current);
          handleClockUpdate(clk);
        }

        // 1. GOL TELEMETRİSİ (GoalScored / game:goal_scored / StatfeedEvent Goal)
        const isGoalEvent = eventName === 'GoalScored' || eventName === 'game:goal_scored' || (eventName === 'StatfeedEvent' && eventData?.EventName === 'Goal');
        if (isGoalEvent && eventData) {
          // SADECE aktif bir Özel Maç içindeysek gol kaydet! Antrenmandaki golleri yoksay!
          if (!initialMatchStateRef.current || initialMatchStateRef.current.playlistId !== 6) {
            return;
          }
          const currentClock = extractGameClock(eventData?.Game, latestGameStateRef.current?.timeSeconds ?? 0);
          const scorerName = eventData.Scorer?.Name || eventData.scorer?.name || eventData.MainTarget?.Name;
          const speedKmh = Math.round((eventData.GoalSpeedKPH ?? eventData.GoalSpeed ?? eventData.goalSpeed ?? 0) * (eventData.GoalSpeedKPH ? 1 : 0.036));
          const assistName = eventData.Assister?.Name || eventData.assister?.name || eventData.SecondaryTarget?.Name || null;
          const scorerTeam = eventData.Scorer?.TeamNum ?? eventData.scorer?.teamNum ?? null;

          // Son golü kontrol et (Psyonix çift bildirim ve tekrar sonu kontrolü)
          const lastGoal = goalEventsRef.current[goalEventsRef.current.length - 1];
          const isRecentDuplicate = lastGoal && Math.abs((lastGoal.timeSeconds ?? 0) - currentClock) <= 4;
          const currentTotalScore = (latestGameStateRef.current?.blueScore ?? 0) + (latestGameStateRef.current?.orangeScore ?? 0);
          const scoreAlreadySaturated = currentTotalScore > 0 && goalEventsRef.current.length >= currentTotalScore;

          // Eğer son 4 saniyede bildirilmişse VEYA tablodaki toplam gol sayısına zaten ulaşılmışsa VEYA gol atan ismi yoksa:
          if (isRecentDuplicate || scoreAlreadySaturated || (!scorerName && speedKmh === 0)) {
            if (lastGoal && (lastGoal.scorer === 'Bilinmeyen Oyuncu' || lastGoal.speedKmh === 0) && scorerName) {
              lastGoal.scorer = scorerName;
              lastGoal.scorerTeam = scorerTeam;
              lastGoal.speedKmh = speedKmh || lastGoal.speedKmh;
              lastGoal.assist = assistName || lastGoal.assist;

              for (let i = timelineRef.current.length - 1; i >= 0; i--) {
                if (timelineRef.current[i].type === 'GOAL') {
                  timelineRef.current[i].detail = `⚽ Gol: ${lastGoal.scorer} (${lastGoal.speedKmh} km/h)${lastGoal.assist ? ` - Asist: ${lastGoal.assist}` : ''}`;
                  timelineRef.current[i].data = { ...lastGoal };
                  break;
                }
              }
            }
            return;
          }

          const goalInfo = {
            time: formatTime(currentClock),
            timeSeconds: currentClock,
            speedKmh,
            scorer: scorerName || 'Bilinmeyen Oyuncu',
            scorerTeam,
            assist: assistName,
          };
          goalEventsRef.current.push(goalInfo);

          timelineRef.current.push({
            time: formatTime(currentClock),
            type: 'GOAL',
            detail: `⚽ Gol: ${goalInfo.scorer} (${goalInfo.speedKmh} km/h)${goalInfo.assist ? ` - Asist: ${goalInfo.assist}` : ''}`,
            data: goalInfo,
          });
        }

        // 2. DEMO / PATLATMA TELEMETRİSİ (StatfeedEvent Demolish)
        if ((eventName === 'StatfeedEvent' && eventData?.EventName === 'Demolish') || eventName === 'game:statfeed_event') {
          const currentClock = latestGameStateRef.current?.timeSeconds ?? 0;
          timelineRef.current.push({
            time: formatTime(currentClock),
            type: 'DEMO',
            detail: `💥 Demo: ${eventData.MainTarget?.Name || '?'} ➔ ${eventData.SecondaryTarget?.Name || '?'}`,
          });
        }

        // 3. BAŞLAMA VURUŞU (RoundStarted / game:round_started_go)
        if (eventName === 'RoundStarted' || eventName === 'game:round_started_go') {
          // Antrenmandaki vuruşları yoksay
          if (!initialMatchStateRef.current || initialMatchStateRef.current.playlistId !== 6) {
            return;
          }
          // İlk başlama vuruşunda gerçek oynanış kronometresini sahaya göre sıfırla/başlat
          if (!matchStartTimeRef.current || (latestGameStateRef.current?.timeSeconds ?? 300) >= 298) {
            matchStartTimeRef.current = Date.now();
          }
          const currentClock = latestGameStateRef.current?.timeSeconds ?? 300;
          const lastTl = timelineRef.current[timelineRef.current.length - 1];
          if (lastTl && lastTl.type === 'KICKOFF' && Math.abs((lastClockRef.current ?? 300) - currentClock) <= 2) {
            return;
          }
          timelineRef.current.push({
            time: formatTime(currentClock),
            type: 'KICKOFF',
            detail: '🏁 Başlama vuruşu yapıldı.',
          });
          // İlk başlama vuruşunda sunucuya "maç başladı" de (tek küçük istek, sonrası sessiz)
          const kickoffGuid = initialMatchStateRef.current.matchGuid;
          if (kickoffGuid && startedEventGuidRef.current !== kickoffGuid) {
            startedEventGuidRef.current = kickoffGuid;
            sendEvent('started', kickoffGuid);
          }
        }

        // 3b. MAÇ BİTTİ (resmî olay): son durumla mühürle (UpdateState'in bitiş paketi kaçsa bile maç kaybolmasın)
        if (eventName === 'MatchEnded' && eventData?.MatchGuid) {
          finalizeMatch(eventData.MatchGuid, eventData.WinnerTeamNum === 0 || eventData.WinnerTeamNum === 1 ? eventData.WinnerTeamNum : null);
          return;
        }

        // 4. ANA DURUM GÜNCELLEMESİ (UpdateState / game:update_state)
        if ((eventName === 'UpdateState' || eventName === 'game:update_state') && eventData?.Game) {
          const game = eventData.Game || eventData.game || {};
          const currentGuid = eventData.MatchGuid || eventData.matchGuid || '';

          // ─── EĞİTİM / ANTRENMAN (FREEPLAY) KORUMASI ───
          // Turnuva maçları DAİMA PlaylistId 6 (Özel Maç / Private Match) olmak zorundadır.
          // Eğitim (Freeplay, Custom Training vb.) veya antrenman sahalarını kesinlikle maçtan sayma!
          const isTrainingOrFreeplay = Boolean(
            game.bIsTraining ||
            game.bIsCustomTraining ||
            game.PlaylistId === 23 ||
            game.PlaylistId === 24 ||
            (game.PlaylistId !== 6 && game.PlaylistId !== undefined && game.PlaylistId !== null) ||
            (game.Arena && (game.Arena.toLowerCase().includes('editor') || game.Arena.toLowerCase().includes('training')))
          );

          if (isTrainingOrFreeplay) {
            // Antrenmandan kalan kirli referans varsa temizle
            if (initialMatchStateRef.current && initialMatchStateRef.current.playlistId !== 6) {
              initialMatchStateRef.current = null;
            }
            return;
          }

          const teams = game.Teams || game.teams || [];
          let blueScore = 0, orangeScore = 0;
          teams.forEach((t) => {
            const num = t.TeamNum ?? t.teamNum;
            const score = t.Score ?? t.score ?? 0;
            if (num === 0) blueScore = score;
            if (num === 1) orangeScore = score;
          });

          const currentSec = extractGameClock(game, lastClockRef.current ?? 300);
          const hasWinner = Boolean(game.bHasWinner ?? game.HasWinner ?? game.hasWinner);
          const isOvertime = Boolean(game.bOvertime ?? game.IsOT ?? game.isOT);
          const isGameRunning = !hasWinner && !sealedMatchesRef.current.has(currentGuid) && (currentSec > 0 || isOvertime || currentSec === null);

          if (isGameRunning && game.bHasTarget && game.Target?.Name && !game.bReplay) {
            const tn = String(game.Target.Name);
            targetCountsRef.current[tn] = (targetCountsRef.current[tn] || 0) + 1;
          }

          if (isGameRunning) {
            if (!initialMatchStateRef.current) {
              targetCountsRef.current = {};
              // Başlangıç süresi güvenliği: Yükleme ekranında 0 geldiyse dahi 300 varsay.
              const safeStartSec = (currentSec && currentSec > 30) ? currentSec : 300;
              matchStartTimeRef.current = Date.now();
              timelineRef.current = [];
              goalEventsRef.current = [];
              prevScoresRef.current = { blue: blueScore, orange: orangeScore };
              clockJumpsRef.current = [];
              lastClockRef.current = safeStartSec;
              // Baştan izleme: bu maçı ilk gördüğümde saat ~5:00 ve skor 0-0 ise baştan izliyorum; değilse ORTADAN girmişim
              coverageRef.current = { fromStart: Boolean(currentSec >= 298 && blueScore + orangeScore === 0), gap: false };
              setUploadState({ status: 'idle', message: '' });
              setMatchData(null); // Yeni maç başladığı an eski maç kartını ekrandan temizle!
              setShowTimeline(false);
              lastSeenPlayersRef.current = (eventData.Players || []).map((p) => ({ Name: p.Name, TeamNum: p.TeamNum }));
              initialMatchStateRef.current = {
                matchGuid: currentGuid,
                startSeconds: safeStartSec,
                playlistId: game.PlaylistId ?? 6,
                arena: game.Arena || 'Bilinmeyen Saha',
                initialPlayerCount: (eventData.Players || []).length,
              };

              timelineRef.current.push({
                time: formatTime(safeStartSec),
                type: 'MATCH_START',
                detail: `🎮 Maç başladı (Mod: Özel Maç, Saha: ${game.Arena})`,
              });
            } else if (currentGuid && initialMatchStateRef.current.matchGuid !== currentGuid) {
              initialMatchStateRef.current.matchGuid = currentGuid;
            }
          }

          // Skor artışı ile otomatik gol tespiti (Asla gol kaçırmayan emniyet ağı)
          if (isGameRunning) {
            const currentPlayersList = eventData.Players || eventData.players || [];
            if (blueScore > prevScoresRef.current.blue) {
              const diff = blueScore - prevScoresRef.current.blue;
              for (let i = 0; i < diff; i++) {
                const bluePs = currentPlayersList.filter((p) => (p.TeamNum ?? p.teamNum) === 0);
                const scorerP = bluePs.find((p) => (p.Goals ?? p.goals ?? 0) > 0) || bluePs[0];
                const scorerName = scorerP?.Name || scorerP?.name || 'Mavi Takım';
                const lastG = goalEventsRef.current[goalEventsRef.current.length - 1];
                if (!lastG || Math.abs((lastG.timeSeconds ?? 0) - currentSec) > 3) {
                  const gInfo = {
                    time: formatTime(currentSec),
                    timeSeconds: currentSec,
                    speedKmh: 0,
                    scorer: scorerName,
                    scorerTeam: 0,
                    assist: null,
                  };
                  goalEventsRef.current.push(gInfo);
                  timelineRef.current.push({
                    time: formatTime(currentSec),
                    type: 'GOAL',
                    detail: `⚽ Gol: ${scorerName} (Mavi Takım) ➔ Skor: ${blueScore} - ${orangeScore}`,
                    data: gInfo,
                  });
                }
              }
              prevScoresRef.current.blue = blueScore;
            }

            if (orangeScore > prevScoresRef.current.orange) {
              const diff = orangeScore - prevScoresRef.current.orange;
              for (let i = 0; i < diff; i++) {
                const orangePs = currentPlayersList.filter((p) => (p.TeamNum ?? p.teamNum) === 1);
                const scorerP = orangePs.find((p) => (p.Goals ?? p.goals ?? 0) > 0) || orangePs[0];
                const scorerName = scorerP?.Name || scorerP?.name || 'Turuncu Takım';
                const lastG = goalEventsRef.current[goalEventsRef.current.length - 1];
                if (!lastG || Math.abs((lastG.timeSeconds ?? 0) - currentSec) > 3) {
                  const gInfo = {
                    time: formatTime(currentSec),
                    timeSeconds: currentSec,
                    speedKmh: 0,
                    scorer: scorerName,
                    scorerTeam: 1,
                    assist: null,
                  };
                  goalEventsRef.current.push(gInfo);
                  timelineRef.current.push({
                    time: formatTime(currentSec),
                    type: 'GOAL',
                    detail: `⚽ Gol: ${scorerName} (Turuncu Takım) ➔ Skor: ${blueScore} - ${orangeScore}`,
                    data: gInfo,
                  });
                }
              }
              prevScoresRef.current.orange = orangeScore;
            }
          }

          // Merkezi saat ve sıçrama güncellemesi
          handleClockUpdate(currentSec);

          // Oyuncu giriş/çıkış kontrolü
          const currentPlayers = eventData.Players || eventData.players || [];
          const currentNames = new Set(currentPlayers.map((p) => p.Name || p.name));
          const prevNames = new Set(lastSeenPlayersRef.current.map((p) => p.Name || p.name));

          if (lastSeenPlayersRef.current.length > 0 && isGameRunning && currentSec < 295) {
            for (const prevP of lastSeenPlayersRef.current) {
              const pName = prevP.Name || prevP.name;
              const isBot = KNOWN_BOT_NAMES.has((pName || '').toLowerCase());
              if (!isBot && !currentNames.has(pName)) {
                timelineRef.current.push({
                  time: formatTime(currentSec),
                  type: 'PLAYER_LEFT',
                  detail: `🚪 Oyuncu maçı terk etti: ${pName} (${prevP.TeamNum === 0 ? 'Mavi' : 'Turuncu'})`,
                  player: pName,
                  team: prevP.TeamNum,
                });
              }
            }

            for (const currP of currentPlayers) {
              const pName = currP.Name || currP.name;
              const isBot = KNOWN_BOT_NAMES.has((pName || '').toLowerCase());
              if (!isBot && !prevNames.has(pName)) {
                timelineRef.current.push({
                  time: formatTime(currentSec),
                  type: 'PLAYER_JOINED',
                  detail: `🙋 Oyuncu maça katıldı: ${pName} (${currP.TeamNum === 0 ? 'Mavi' : 'Turuncu'})`,
                  player: pName,
                  team: currP.TeamNum,
                });
              }
            }
          }
          lastSeenPlayersRef.current = currentPlayers.map((p) => ({ Name: p.Name || p.name, TeamNum: p.TeamNum ?? p.teamNum }));

          // Oyuncuların zengin istatistiklerini RAM'de tut
          const parsedPlayers = currentPlayers.map((p) => {
            const pName = p.Name || p.name || '';
            const pId = p.PrimaryId || p.primaryId || '';
            const isBot = Boolean(
              p.bBot ?? p.bIsBot ?? p.isBot ??
              (pId && pId.startsWith('Unknown')) ||
              KNOWN_BOT_NAMES.has(pName.toLowerCase())
            );
            return {
              name: pName,
              primaryId: pId,
              team: p.TeamNum ?? p.teamNum ?? 0,
              score: p.Score ?? p.score ?? 0,
              goals: p.Goals ?? p.goals ?? 0,
              assists: p.Assists ?? p.assists ?? 0,
              saves: p.Saves ?? p.saves ?? 0,
              shots: p.Shots ?? p.shots ?? 0,
              demos: p.Demos ?? p.demos ?? 0,
              touches: p.Touches ?? p.touches ?? 0,
              carTouches: p.CarTouches ?? p.carTouches ?? 0,
              boost: p.Boost ?? p.boost ?? null,
              isPrimary: Boolean(p.IsPrimary ?? p.isPrimary ?? false),
              isBot,
            };
          });

          latestGameStateRef.current = {
            matchGuid: currentGuid,
            blueScore,
            orangeScore,
            timeSeconds: currentSec,
            overtime: isOvertime,
            isActive: !hasWinner,
            playlistId: game.PlaylistId,
            arena: game.Arena,
            players: parsedPlayers,
          };

          const nowUi = Date.now();
          if (nowUi - lastUiUpdateRef.current > 1000) {
            lastUiUpdateRef.current = nowUi;
            setLiveState({ ...latestGameStateRef.current });
          }

          if (!hasWinner && currentGuid) {
            seenActiveMatchesRef.current.add(currentGuid);
          }

          // ─── MAÇ BİTTİ (hasWinner === true): mühürleme ve yükleme tek yerde ───
          if (hasWinner) {
            finalizeMatch(currentGuid, null);
          }
        }
      } catch (err) {
        console.error('Event processing error:', err);
      }
    });

    return () => {
      if (typeof unbindStatus === 'function') unbindStatus();
      if (typeof unbindEvent === 'function') unbindEvent();
      if (typeof unbindProc === 'function') unbindProc();
    };
  }, []);

  // Maç sonu yüklemesi: cevabı bekler, geçici hatada otomatik yeniden dener, ekranda durumu gösterir
  const doUpload = async (payload) => {
    pendingUploadRef.current = payload;
    setUploadState({ status: 'sending', message: 'Siteye gönderiliyor...' });
    const r = await apiCall('/companion/matches', 'POST', payload);
    if (r.ok) {
      pendingUploadRef.current = null;
      setUploadState({ status: 'sent', message: r.data?.duplicate ? 'Bu maç zaten gönderilmişti ✓' : (OUTCOME_TEXT[r.data?.outcome] || 'Gönderildi ✓') });
    } else {
      setUploadState({ status: 'failed', message: `Gönderilemedi (${r.error}). "Tekrar gönder" ile yeniden dene.` });
    }
  };

  // Maç bitişi: baştan sona izlenmediyse YÜKLEME YAPMAZ; tam izlendiyse tek istekle gönderir
  const finalizeMatch = async (guid, winnerHint) => {
    const state = latestGameStateRef.current;
    if (!guid || !state || state.matchGuid !== guid) return;
    if (sealedMatchesRef.current.has(guid)) return; // zaten mühürlendi (resmî olay + bitiş paketi çift tetiklemesin)
    if (!seenActiveMatchesRef.current.has(guid)) return; // yalnızca oynanırken görülmüş maç

    sealedMatchesRef.current.add(guid);
    seenActiveMatchesRef.current.delete(guid);
    if (sealedMatchesRef.current.size > 100) sealedMatchesRef.current.clear();

    const initial = initialMatchStateRef.current ? { ...initialMatchStateRef.current } : {};
    initialMatchStateRef.current = null;
    const coverage = { ...coverageRef.current };
    coverageRef.current = { fromStart: false, gap: false };
    const jumps = [...clockJumpsRef.current];
    clockJumpsRef.current = [];

    const { blueScore, orangeScore, players: parsedPlayers } = state;
    const isOvertime = Boolean(state.overtime);
    const currentSec = state.timeSeconds ?? 0;
    const winnerTeamNum = winnerHint ?? (blueScore > orangeScore ? 0 : 1);
    const winner = winnerTeamNum === 0 ? 'Mavi Takım' : 'Turuncu Takım';
    const finalScore = `${blueScore}-${orangeScore}`;
    const elapsedSeconds = matchStartTimeRef.current
      ? Math.max(1, Math.round((Date.now() - matchStartTimeRef.current) / 1000))
      : 300;
    matchStartTimeRef.current = null;
    lastClockRef.current = null;

    sendEvent('ended', guid);

    // ─── DENETİMLER (yalnızca baştan sona izlenen maçta; eksik izlemede yanlış alarm vermemek için hiç yapılmaz) ───
    const complete = coverage.fromStart && !coverage.gap;
    const flags = [];
    const warnings = [];
    const notes = [];

    if (complete) {
      // 1. Bot
      const botPlayers = parsedPlayers.filter((p) => p.isBot);
      if (botPlayers.length > 0) {
        flags.push('BOT_DETECTED');
        warnings.push(`Odada ${botPlayers.length} adet yapay zeka (bot) tespit edildi: ${botPlayers.map((b) => b.name).join(', ')}.`);
      }

      // 2. Eksik oyuncu
      const blueCount = parsedPlayers.filter((p) => p.team === 0 && !p.isBot).length;
      const orangeCount = parsedPlayers.filter((p) => p.team === 1 && !p.isBot).length;
      if (blueCount < 1 || orangeCount < 1) {
        flags.push('MISSING_PLAYERS');
        warnings.push(`Takımlardan birinde gerçek oyuncu yok (Mavi: ${blueCount}, Turuncu: ${orangeCount}). Tek taraflı maç.`);
      }

      // 3. Süre: standart başlangıç, büyük saat sıçraması, gerçek süre ile oyun süresi uyumu
      const startSec = initial.startSeconds ?? 300;
      const tamper = [];
      if (Math.abs(startSec - 300) > 3) tamper.push(`Maç standart süre (5:00) ile başlatılmadı: ${formatTime(startSec)} ile başladı.`);
      const bigJumps = jumps.filter((j) => Math.abs(j.diff) >= 10);
      if (bigJumps.length > 0 || jumps.length >= 3) {
        tamper.push(`Maç sırasında oyun saatinde ani sıçrama tespit edildi [${jumps.map((j) => j.desc).join(', ')}].`);
      } else if (jumps.length > 0) {
        notes.push(`Oyun saatinde küçük takılma: ${jumps.map((j) => j.desc).join(', ')} (kasma / bağlantı kaynaklı olabilir).`);
      }
      const clockSecondsElapsed = startSec - currentSec;
      const clockDiscrepancy = clockSecondsElapsed - elapsedSeconds;
      if (!isOvertime && clockDiscrepancy > 15) {
        tamper.push(`Tüketilen oyun süresi (${clockSecondsElapsed} sn) gerçek geçen süreden (${elapsedSeconds} sn) fazla.`);
      }
      if (tamper.length > 0) {
        flags.push('CLOCK_TAMPERING');
        warnings.push(...tamper);
      }

      // 4. Erken bitiş / lobiyi terk ayrımı
      const leftNames = timelineRef.current.filter((t) => t.type === 'PLAYER_LEFT').map((t) => t.player).filter(Boolean);
      if (leftNames.length > 0) notes.push(`Maç sırasında oyuncu(lar) ayrıldı: ${Array.from(new Set(leftNames)).join(', ')}.`);
      if (elapsedSeconds < 90) {
        if (leftNames.length > 0) {
          notes.push('Oyuncu/takım odadan çıktığı için maç erken sonlandı (hükmen durum).');
        } else if (bigJumps.length === 0) {
          flags.push('EARLY_FINISH');
          warnings.push(`Maç 90 saniyeden kısa sürede bitti (${elapsedSeconds} sn) ve lobiyi terk eden olmadı (hızlı bitirme şüphesi).`);
        }
      }
    }

    timelineRef.current.push({
      time: formatTime(currentSec),
      type: 'MATCH_CONCLUDED',
      detail: `🏆 Maç Bitti! Kazanan: ${winner} | Skor: ${finalScore} | Süre: ${elapsedSeconds} sn`,
    });

    const incidentReport = { flags, warnings, notes, isClean: flags.length === 0 };
    const maxGoalSpeed = goalEventsRef.current.reduce((max, g) => Math.max(max, g.speedKmh || 0), 0);

    // Kendi oyuncum: oyunun kamerayı takip ettiği oyuncu (maç boyunca en sık görülen hedef); ad yazdırmaya gerek yok
    const targetEntries = Object.entries(targetCountsRef.current).sort((a, b) => b[1] - a[1]);
    targetCountsRef.current = {};
    const targetName = targetEntries.length > 0 ? targetEntries[0][0] : '';
    const meP = targetName ? parsedPlayers.find((p) => !p.isBot && p.name === targetName) : null;
    const me = { name: meP?.name || '', primaryId: meP?.primaryId || '', teamNum: meP?.team ?? null, resolved: Boolean(meP) };

    // Zaman çizelgesi: ilk olay (maç başı) + son olaylar
    const tl = timelineRef.current;
    const timeline = tl.length > 120 ? [tl[0], ...tl.slice(-119)] : [...tl];

    setMatchData({
      matchId: guid, winner, winnerTeamNum, blueScore, orangeScore, score: finalScore,
      durationSeconds: elapsedSeconds, incidentReport, players: parsedPlayers, timeline,
    });

    if (!complete) {
      setUploadState({
        status: 'skipped',
        message: coverage.fromStart
          ? 'Maç sırasında oyunla bağlantı/veri kesildi (ör. maçtan çıkıp girdin). Kaydın eksik kalacağı için veri GÖNDERİLMEDİ; skoru yetkili girecek.'
          : 'Bu maçı baştan izleyemedim (Companion maç başladıktan sonra açıldı). Veri GÖNDERİLMEDİ; skoru yetkili girecek.',
      });
      return;
    }

    await doUpload({
      matchGuid: guid,
      blueScore,
      orangeScore,
      winnerTeamNum,
      durationSeconds: elapsedSeconds,
      complete: true,
      me,
      incidentReport,
      players: parsedPlayers,
      timeline,
      goalEvents: goalEventsRef.current || [],
      maxGoalSpeedKmh: maxGoalSpeed || 0,
    });
  };

  // Google ile giriş: tarayıcıdan dönen kimlik bilgisini Firebase'e ver
  useEffect(() => {
    if (!window.electronAPI?.onGoogleLoginResult) return undefined;
    const unbind = window.electronAPI.onGoogleLoginResult(async (res) => {
      if (!res?.ok) {
        setLoginError(res?.error || 'Google girişi tamamlanamadı.');
        setGoogleBusy(false);
        return;
      }
      try {
        const cred = GoogleAuthProvider.credential(res.idToken || null, res.accessToken || null);
        await signInWithCredential(auth, cred);
      } catch (err) {
        setLoginError('Google girişi başarısız: ' + (err.message || err));
      }
      setGoogleBusy(false);
    });
    return unbind;
  }, []);


  const handleLogin = async (e) => {
    e.preventDefault();
    setLoginError('');
    try {
      await signInWithEmailAndPassword(auth, email, password);
    } catch (err) {
      setLoginError(err.message);
    }
  };

  const handleLogout = () => signOut(auth);

  const handleGoogleLogin = async () => {
    setLoginError('');
    setGoogleBusy(true);
    try {
      const r = await window.electronAPI.startGoogleLogin();
      if (!r?.ok) { setLoginError(r?.error || 'Tarayıcı açılamadı.'); setGoogleBusy(false); }
    } catch (err) {
      setLoginError('Google girişi başlatılamadı: ' + (err.message || err));
      setGoogleBusy(false);
    }
  };

  if (!user) {
    return (
      <div className="container">
        <div className="login-box">
          <Rocket size={48} className="rocket-icon" />
          <h2>RL Companion</h2>
          <p style={{ fontSize: '0.8rem', color: '#94a3b8', margin: '0 0 16px' }}>
            Turnuva maçlarını otonom dinlemek ve telemetri toplamak için giriş yapın.
          </p>
          <form onSubmit={handleLogin}>
            <input type="email" placeholder="E-posta" value={email} onChange={e => setEmail(e.target.value)} required />
            <input type="password" placeholder="Şifre" value={password} onChange={e => setPassword(e.target.value)} required />
            {loginError && <p className="error">{loginError}</p>}
            <button type="submit">Giriş Yap</button>
          </form>
          <div style={{ margin: '12px 0 8px', fontSize: '0.75rem', color: '#64748b', textAlign: 'center' }}>veya</div>
          <button type="button" onClick={handleGoogleLogin} disabled={googleBusy} className="btn-secondary" style={{ width: '100%' }}>
            {googleBusy ? 'Tarayıcıda Google girişi bekleniyor...' : 'Google ile Giriş Yap'}
          </button>
          {googleBusy && <p style={{ fontSize: '0.72rem', color: '#94a3b8', marginTop: 8 }}>Açılan tarayıcı sekmesinde Google hesabınla giriş yap, sonra bu pencereye dön.</p>}
        </div>
      </div>
    );
  }

  return (
    <div className="container">
      <div className="header">
        <Rocket size={22} style={{ color: '#38bdf8' }} />
        <div style={{ flex: 1 }}>
          <h2 style={{ fontSize: '1rem', margin: 0 }}>Rocket Clash Companion</h2>
          <span style={{ fontSize: '0.72rem', color: '#94a3b8' }}>Kriz Masası & Telemetri Portu</span>
        </div>
      </div>

      <div className="status-box">
        <div className={`status-indicator ${status.includes('Bağlandı') ? 'active' : ''}`} />
        <span style={{ fontWeight: 600 }}>{statusText}</span>
        <span className="user-email">{user.email}</span>
      </div>


      <div className="main-content">
        {matchData ? (
          <div className="match-result-card">
            <Trophy size={42} className="trophy-icon" />
            <h3 style={{ margin: '0 0 6px', color: '#4ade80', fontSize: '1.25rem' }}>Maç Tamamlandı!</h3>
            <div className="score-display">
              <span className="score-badge blue">{matchData.blueScore}</span>
              <span className="score-divider">—</span>
              <span className="score-badge orange">{matchData.orangeScore}</span>
            </div>
            <p style={{ margin: '4px 0 12px', fontSize: '0.88rem', color: '#cbd5e1' }}>
              Kazanan: <strong>{matchData.winner}</strong>
            </p>

            {/* Kriz Masası Durum Rozeti */}
            {matchData.incidentReport?.isClean ? (
              <div className="status-alert-box clean">
                <CheckCircle2 size={16} color="#22c55e" />
                <span>Kural ihlali tespit edilmedi (Tertemiz Maç).</span>
              </div>
            ) : (
              <div className="status-alert-box warning">
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 700, color: '#f87171' }}>
                  <ShieldAlert size={16} /> Kriz Masası Uyarısı ({matchData.incidentReport?.flags?.length} Bayrak):
                </div>
                <div style={{ marginTop: 4, display: 'flex', flexDirection: 'column', gap: 2 }}>
                  {matchData.incidentReport?.warnings?.map((w, idx) => (
                    <span key={idx} style={{ fontSize: '0.75rem' }}>• {w}</span>
                  ))}
                </div>
              </div>
            )}

            {uploadState.status !== 'idle' && (
              <div style={{ marginTop: 10, padding: '8px 10px', borderRadius: 8, fontSize: '0.78rem', textAlign: 'left',
                background: uploadState.status === 'failed' ? 'rgba(239,68,68,0.12)' : uploadState.status === 'skipped' ? 'rgba(148,163,184,0.12)' : 'rgba(34,197,94,0.1)',
                color: uploadState.status === 'failed' ? '#fca5a5' : uploadState.status === 'skipped' ? '#cbd5e1' : '#86efac' }}>
                {uploadState.message}
                {uploadState.status === 'failed' && pendingUploadRef.current && (
                  <button className="btn-secondary" style={{ marginLeft: 8, padding: '2px 8px' }} onClick={() => doUpload(pendingUploadRef.current)}>Tekrar gönder</button>
                )}
              </div>
            )}

            <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
              <button className="btn-secondary" onClick={() => setShowTimeline(!showTimeline)}>
                {showTimeline ? 'Günlüğü Gizle' : 'Olay Günlüğü'}
              </button>
              <button className="btn-primary" onClick={() => { setMatchData(null); setShowTimeline(false); }}>
                Yeni Maç Bekle
              </button>
            </div>

            {showTimeline && matchData.timeline && (
              <div className="timeline-box">
                <h4 style={{ margin: '0 0 8px', fontSize: '0.8rem', color: '#93c5fd' }}>Adli Telemetri Akışı:</h4>
                <div className="timeline-items">
                  {matchData.timeline.map((item, idx) => (
                    <div key={idx} className="timeline-item">
                      <span className="timeline-time">{item.time}</span>
                      <span className="timeline-detail">{item.detail}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : liveState && liveState.isActive ? (
          <div className="live-match-card">
            <div className="live-badge">
              <span className="pulse-dot" /> CANLI MAÇ OYNANIYOR
            </div>
            <div className="score-display">
              <span className="score-badge blue">{liveState.blueScore}</span>
              <span className="live-clock">{formatTime(liveState.timeSeconds)}</span>
              <span className="score-badge orange">{liveState.orangeScore}</span>
            </div>
            <div className="live-info-row">
              <span><Users size={13} /> {liveState.players?.length || 0} Oyuncu</span>
              <span><Activity size={13} /> {liveState.arena || 'Saha'}</span>
            </div>
            <div className="players-mini-list">
              {liveState.players?.map((p, idx) => (
                <div key={idx} className={`player-mini-chip ${p.team === 0 ? 'blue' : 'orange'}`}>
                  {p.name} {p.isBot && '(Bot)'} - {p.score}p ({p.goals}G)
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="waiting-match">
            <div className="radar-icon-box">
              <Flame size={36} color="#38bdf8" />
            </div>
            <p style={{ fontWeight: 600, color: '#f8fafc', margin: '0 0 4px' }}>Turnuva Maçı Bekleniyor</p>
            <p style={{ fontSize: '0.78rem', color: '#64748b', maxWidth: 260, margin: '0 auto 16px' }}>
              Rocket League'de özel odaya girdiğinizde Companion maçı otomatik algılayacak ve istatistikleri kaydedecektir.
            </p>
            <div className="loader" />

          </div>
        )}
      </div>

      <div className="footer">
        <button className="btn-logout" onClick={handleLogout}><LogOut size={14} /> Çıkış</button>
      </div>
    </div>
  );
}

export default App;
