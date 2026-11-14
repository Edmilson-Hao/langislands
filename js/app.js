(() => {
  const { pinyin } = window.pinyinPro || {};
  const STORAGE_KEY = 'langislands_v1';

  // ---------- State ----------
  let state = {
    islands: [],
    stats: {
      totalPlays: 0,
      totalReviews: 0,
      daily: {},          // YYYY-MM-DD: { plays, reviews }
      islandPlays: {},    // islandId: count
      streak: 0,
      lastActive: null
    },
    settings: { revealDefault: false, voice: 'random', volume: 0.9 }
  };
  let currentIslandId = null;
  let revealAll = false;
  let filter = 'phrases'; // phrases | words
  let fcType = 'words';
  let fcQueue = [];
  let fcIndex = 0;
  let playing = false;
  let playQueue = [];
  let playIndex = 0;
  let utterance = null;
  let synth = window.speechSynthesis;
  let zhVoices = [];

  // ---------- Utils ----------
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const today = () => new Date().toISOString().slice(0, 10);
  const $ = (sel, el = document) => el.querySelector(sel);
  const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

  // Vozes prioritárias (melhor qualidade conhecida)
  const PREFERRED_VOICE_PATTERNS = [
    /yaoyao|yao yao|microsoft yaoyao/i,
    /kangkang|kang kang|microsoft kangkang/i,
    /tingting|ting-ting|sin-ji|mei-jia/i,
    /google.*普通话|google.*mandarin|zh-cn.*google/i,
    /huihui|zhiwei|yunyang/i,
    /chinese.*(china|prc|simplified)|普通话/
  ];

  function loadVoices() {
    if (!synth) { zhVoices = []; return; }
    const all = synth.getVoices();
    const zhAll = all.filter(v =>
      v.lang === 'zh-CN' || v.lang === 'zh-TW' || v.lang.startsWith('zh') ||
      /chinese|中文|普通话|國語/i.test(v.name)
    );
    const ranked = [];
    for (const pat of PREFERRED_VOICE_PATTERNS) {
      for (const v of zhAll) {
        if (pat.test(v.name) && !ranked.includes(v)) {
          ranked.push(v);
          if (ranked.length >= 4) break;
        }
      }
      if (ranked.length >= 4) break;
    }
    if (ranked.length < 2) {
      for (const v of zhAll) {
        if (!ranked.includes(v)) {
          ranked.push(v);
          if (ranked.length >= 4) break;
        }
      }
    }
    zhVoices = ranked.length ? ranked : zhAll.slice(0, 4);
    populateVoiceSelect();
  }

  function populateVoiceSelect() {
    const sel = $('#voice-select');
    if (!sel) return;
    const current = state.settings.voice || 'random';
    sel.innerHTML = '<option value="random">Aleatória (entre as melhores)</option>';
    zhVoices.forEach(v => {
      const opt = document.createElement('option');
      opt.value = v.name;
      opt.textContent = `${v.name} (${v.lang})`;
      sel.appendChild(opt);
    });
    if ([...sel.options].some(o => o.value === current)) sel.value = current;
    else sel.value = 'random';
  }

  function pickVoice() {
    if (!zhVoices.length) loadVoices();
    if (!zhVoices.length) return null;
    const pref = state.settings.voice || 'random';
    if (pref !== 'random') {
      const found = zhVoices.find(v => v.name === pref);
      if (found) return found;
    }
    return zhVoices[Math.floor(Math.random() * zhVoices.length)];
  }

  function toast(msg, type = '') {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'toast show ' + type;
    setTimeout(() => t.classList.remove('show'), 2200);
  }

  function save() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        state = { ...state, ...parsed };
        if (!state.stats.daily) state.stats.daily = {};
        if (!state.stats.islandPlays) state.stats.islandPlays = {};
      }
    } catch (e) { console.warn(e); }
  }

  function getPinyin(text) {
    if (!pinyin || !text) return '';
    try {
      return pinyin(text, { toneType: 'symbol', type: 'string' });
    } catch { return ''; }
  }

  function speak(text, onEnd) {
    if (!synth) { onEnd && onEnd(); return; }
    synth.cancel();
    utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'zh-CN';
    utterance.rate = 0.9;
    utterance.volume = Math.max(0, Math.min(1, state.settings.volume ?? 0.9));
    const voice = pickVoice();
    if (voice) utterance.voice = voice;
    utterance.onend = () => { onEnd && onEnd(); };
    utterance.onerror = () => { onEnd && onEnd(); };
    synth.speak(utterance);
  }

  function stopSpeak() {
    if (synth) synth.cancel();
    playing = false;
    playQueue = [];
    $('#btn-global-play').style.display = '';
    $('#btn-stop').style.display = 'none';
    $$('.item-row.playing').forEach(r => r.classList.remove('playing'));
  }

  function recordPlay(islandId, count = 1) {
    state.stats.totalPlays += count;
    const d = today();
    if (!state.stats.daily[d]) state.stats.daily[d] = { plays: 0, reviews: 0 };
    state.stats.daily[d].plays += count;
    if (islandId) {
      state.stats.islandPlays[islandId] = (state.stats.islandPlays[islandId] || 0) + count;
    }
    state.stats.lastActive = d;
    updateStreak();
    save();
  }

  function recordReview(correct) {
    state.stats.totalReviews += 1;
    const d = today();
    if (!state.stats.daily[d]) state.stats.daily[d] = { plays: 0, reviews: 0 };
    state.stats.daily[d].reviews += 1;
    state.stats.lastActive = d;
    updateStreak();
    save();
  }

  function updateStreak() {
    // simple consecutive days with activity
    let streak = 0;
    let d = new Date();
    for (let i = 0; i < 365; i++) {
      const key = d.toISOString().slice(0, 10);
      const day = state.stats.daily[key];
      if (day && (day.plays > 0 || day.reviews > 0)) {
        streak++;
        d.setDate(d.getDate() - 1);
      } else break;
    }
    state.stats.streak = streak;
  }

  // ---------- Screens ----------
  function showScreen(name) {
    $$('.screen').forEach(s => s.classList.remove('active'));
    $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.screen === name));
    const scr = $(`#screen-${name}`);
    if (scr) scr.classList.add('active');
    if (name === 'home') renderHome();
    if (name === 'stats') renderStats();
    if (name === 'flashcards') renderFcSetup();
    if (name === 'manage') { /* static */ }
    $('#header-title').textContent = name === 'island' ? 'Ilha' : '语言岛';
  }

  // ---------- Home ----------
  function renderHome() {
    const list = $('#islands-list');
    const empty = $('#empty-islands');
    if (!state.islands.length) {
      list.innerHTML = '';
      empty.classList.remove('hidden');
      return;
    }
    empty.classList.add('hidden');
    list.innerHTML = state.islands.map(isl => {
      const pCount = isl.phrases?.length || 0;
      const wCount = isl.words?.length || 0;
      const plays = state.stats.islandPlays[isl.id] || 0;
      return `
        <div class="card selectable" data-id="${isl.id}">
          <div class="flex-between">
            <div>
              <h3>${esc(isl.name)}</h3>
              <p class="meta">${pCount} frases · ${wCount} palavras · ${plays} plays</p>
            </div>
            <span class="badge">${pCount + wCount}</span>
          </div>
        </div>`;
    }).join('');
    list.querySelectorAll('.card').forEach(c => {
      c.addEventListener('click', () => openIsland(c.dataset.id));
    });
  }

  function openIsland(id) {
    currentIslandId = id;
    revealAll = false;
    filter = 'phrases';
    showScreen('island');
    renderIsland();
  }

  // ---------- Island Detail ----------
  function getIsland() {
    return state.islands.find(i => i.id === currentIslandId);
  }

  function renderIsland() {
    const isl = getIsland();
    if (!isl) { showScreen('home'); return; }
    $('#island-name').textContent = isl.name;
    $('#island-meta').textContent = isl.description || `${isl.phrases.length} frases · ${isl.words.length} palavras`;
    $('#phrases-count').textContent = `${isl.phrases.length} frases`;
    $('#words-count').textContent = `${isl.words.length} palavras`;

    $$('.chip[data-filter]').forEach(c => c.classList.toggle('active', c.dataset.filter === filter));
    $('#phrases-section').classList.toggle('hidden', filter !== 'phrases');
    $('#words-section').classList.toggle('hidden', filter !== 'words');
    $('#btn-toggle-reveal').textContent = revealAll ? 'Ocultar' : 'Mostrar tudo';

    // Phrases
    const pl = $('#phrases-list');
    if (!isl.phrases.length) {
      pl.innerHTML = '<div class="empty"><p>Nenhuma frase. Adicione algumas.</p></div>';
    } else {
      pl.innerHTML = isl.phrases.map((p, i) => `
        <div class="item-row" data-id="${p.id}">
          <div class="item-num">${i + 1}</div>
          <div class="item-body">
            <div class="item-hanzi">${esc(p.hanzi)}</div>
            <div class="item-hidden ${revealAll ? '' : 'hidden'}">
              <span class="text-accent">${esc(p.pinyin)}</span> · ${esc(p.translation)}
            </div>
          </div>
          <div class="item-actions">
            <button class="icon-btn btn-play-one" data-text="${escAttr(p.hanzi)}" title="Ouvir">▶</button>
            <button class="icon-btn btn-del-phrase" data-id="${p.id}" title="Apagar">🗑</button>
          </div>
        </div>`).join('');
    }

    // Words
    const wl = $('#words-list');
    if (!isl.words.length) {
      wl.innerHTML = '<div class="empty"><p>Nenhuma palavra. Adicione algumas.</p></div>';
    } else {
      wl.innerHTML = isl.words.map((w, i) => `
        <div class="item-row" data-id="${w.id}">
          <div class="item-num">${i + 1}</div>
          <div class="item-body">
            <div class="item-hanzi">${esc(w.hanzi)}</div>
            <div class="item-hidden ${revealAll ? '' : 'hidden'}">
              <span class="text-accent">${esc(w.pinyin)}</span> · ${esc(w.translation)}
            </div>
          </div>
          <div class="item-actions">
            <button class="icon-btn btn-play-one" data-text="${escAttr(w.hanzi)}" title="Ouvir">▶</button>
            <button class="icon-btn btn-del-word" data-id="${w.id}" title="Apagar">🗑</button>
          </div>
        </div>`).join('');
    }

    // Bind play/delete
    $$('.btn-play-one').forEach(b => {
      b.addEventListener('click', e => {
        e.stopPropagation();
        const row = b.closest('.item-row');
        $$('.item-row.playing').forEach(r => r.classList.remove('playing'));
        row.classList.add('playing');
        speak(b.dataset.text, () => row.classList.remove('playing'));
        recordPlay(currentIslandId);
        // increment item plays
        const item = [...(isl.phrases || []), ...(isl.words || [])].find(x => x.id === row.dataset.id);
        if (item) { item.plays = (item.plays || 0) + 1; save(); }
      });
    });
    $$('.btn-del-phrase').forEach(b => {
      b.addEventListener('click', async e => {
        e.stopPropagation();
        const ok = await confirmDelete('Apagar esta frase?');
        if (!ok) return;
        isl.phrases = isl.phrases.filter(p => p.id !== b.dataset.id);
        save(); renderIsland();
      });
    });
    $$('.btn-del-word').forEach(b => {
      b.addEventListener('click', async e => {
        e.stopPropagation();
        const ok = await confirmDelete('Apagar esta palavra?');
        if (!ok) return;
        isl.words = isl.words.filter(w => w.id !== b.dataset.id);
        save(); renderIsland();
      });
    });
  }

  async function confirmDelete(title) {
    const r = await Swal.fire({
      title, text: 'Esta ação não pode ser desfeita.',
      icon: 'warning', showCancelButton: true,
      confirmButtonText: 'Apagar', cancelButtonText: 'Cancelar',
      confirmButtonColor: '#ef4444', cancelButtonColor: '#475569',
      background: '#1e293b', color: '#f1f5f9'
    });
    return r.isConfirmed;
  }

  // ---------- CRUD Island ----------
  async function createIsland() {
    const { value: form } = await Swal.fire({
      title: 'Nova Ilha',
      html: `
        <input id="swal-name" class="swal2-input" placeholder="Nome (ex: Café)" style="background:#0f172a;color:#f1f5f9;border-color:#475569">
        <input id="swal-desc" class="swal2-input" placeholder="Descrição opcional" style="background:#0f172a;color:#f1f5f9;border-color:#475569">
      `,
      focusConfirm: false,
      showCancelButton: true,
      confirmButtonText: 'Criar',
      cancelButtonText: 'Cancelar',
      confirmButtonColor: '#f59e0b', cancelButtonColor: '#475569',
      background: '#1e293b', color: '#f1f5f9',
      preConfirm: () => {
        const name = $('#swal-name').value.trim();
        if (!name) { Swal.showValidationMessage('Nome obrigatório'); return false; }
        return { name, description: $('#swal-desc').value.trim() };
      }
    });
    if (!form) return;
    const isl = {
      id: uid(),
      name: form.name,
      description: form.description,
      phrases: [],
      words: [],
      createdAt: Date.now()
    };
    state.islands.unshift(isl);
    save();
    toast('Ilha criada', 'success');
    openIsland(isl.id);
  }

  async function editIsland() {
    const isl = getIsland();
    if (!isl) return;
    const { value: form } = await Swal.fire({
      title: 'Editar Ilha',
      html: `
        <input id="swal-name" class="swal2-input" value="${escAttr(isl.name)}" style="background:#0f172a;color:#f1f5f9;border-color:#475569">
        <input id="swal-desc" class="swal2-input" value="${escAttr(isl.description || '')}" style="background:#0f172a;color:#f1f5f9;border-color:#475569">
      `,
      showCancelButton: true,
      confirmButtonText: 'Salvar',
      cancelButtonText: 'Cancelar',
      confirmButtonColor: '#f59e0b', cancelButtonColor: '#475569',
      background: '#1e293b', color: '#f1f5f9',
      preConfirm: () => {
        const name = $('#swal-name').value.trim();
        if (!name) { Swal.showValidationMessage('Nome obrigatório'); return false; }
        return { name, description: $('#swal-desc').value.trim() };
      }
    });
    if (!form) return;
    isl.name = form.name;
    isl.description = form.description;
    save();
    renderIsland();
    toast('Salvo', 'success');
  }

  async function addPhrase() {
    const isl = getIsland();
    if (!isl) return;
    const { value: form } = await Swal.fire({
      title: 'Nova Frase',
      html: `
        <input id="swal-hanzi" class="swal2-input" placeholder="汉字 (mandarim)" style="background:#0f172a;color:#f1f5f9;border-color:#475569">
        <input id="swal-trans" class="swal2-input" placeholder="Tradução" style="background:#0f172a;color:#f1f5f9;border-color:#475569">
        <p class="text-xs" style="color:#94a3b8;margin-top:4px">Pinyin gerado automaticamente</p>
      `,
      showCancelButton: true,
      confirmButtonText: 'Adicionar',
      cancelButtonText: 'Cancelar',
      confirmButtonColor: '#f59e0b', cancelButtonColor: '#475569',
      background: '#1e293b', color: '#f1f5f9',
      preConfirm: () => {
        const hanzi = $('#swal-hanzi').value.trim();
        const translation = $('#swal-trans').value.trim();
        if (!hanzi) { Swal.showValidationMessage('Hanzi obrigatório'); return false; }
        return { hanzi, translation };
      }
    });
    if (!form) return;
    const py = getPinyin(form.hanzi);
    isl.phrases.push({
      id: uid(),
      hanzi: form.hanzi,
      pinyin: py,
      translation: form.translation || '',
      plays: 0
    });
    save();
    renderIsland();
    toast('Frase adicionada', 'success');
  }

  async function addWord() {
    const isl = getIsland();
    if (!isl) return;
    const { value: form } = await Swal.fire({
      title: 'Nova Palavra',
      html: `
        <input id="swal-hanzi" class="swal2-input" placeholder="汉字" style="background:#0f172a;color:#f1f5f9;border-color:#475569">
        <input id="swal-trans" class="swal2-input" placeholder="Tradução" style="background:#0f172a;color:#f1f5f9;border-color:#475569">
      `,
      showCancelButton: true,
      confirmButtonText: 'Adicionar',
      cancelButtonText: 'Cancelar',
      confirmButtonColor: '#f59e0b', cancelButtonColor: '#475569',
      background: '#1e293b', color: '#f1f5f9',
      preConfirm: () => {
        const hanzi = $('#swal-hanzi').value.trim();
        const translation = $('#swal-trans').value.trim();
        if (!hanzi) { Swal.showValidationMessage('Hanzi obrigatório'); return false; }
        return { hanzi, translation };
      }
    });
    if (!form) return;
    const py = getPinyin(form.hanzi);
    isl.words.push({
      id: uid(),
      hanzi: form.hanzi,
      pinyin: py,
      translation: form.translation || '',
      plays: 0,
      reviews: 0,
      ease: 2.5,
      interval: 0,
      due: today()
    });
    save();
    renderIsland();
    toast('Palavra adicionada', 'success');
  }

  // ---------- Batch JSON ----------
  async function batchImport() {
    const isl = getIsland();
    if (!isl) return;
    const { value: raw } = await Swal.fire({
      title: 'Importar JSON (lote)',
      html: `<p class="text-sm" style="color:#94a3b8;text-align:left;margin-bottom:6px">Exemplo:</p>
      <pre style="font-size:0.72rem;text-align:left;background:#0f172a;padding:8px;border-radius:8px;color:#94a3b8;margin-bottom:8px;overflow-x:auto">{
  "phrases": [
    {"hanzi": "我要一杯咖啡", "translation": "Eu quero um café"}
  ],
  "words": [
    {"hanzi": "咖啡", "translation": "café"},
    {"hanzi": "水", "translation": "água"}
  ]
}</pre>
      <textarea id="swal-json" class="swal2-textarea" placeholder='Cole o JSON aqui...' style="background:#0f172a;color:#f1f5f9;border-color:#475569;font-family:monospace;font-size:0.8rem;min-height:120px"></textarea>`,
      showCancelButton: true,
      confirmButtonText: 'Importar',
      cancelButtonText: 'Cancelar',
      confirmButtonColor: '#f59e0b', cancelButtonColor: '#475569',
      background: '#1e293b', color: '#f1f5f9',
      width: '90%',
      preConfirm: () => {
        try {
          const data = JSON.parse($('#swal-json').value.trim() || '{}');
          return data;
        } catch {
          Swal.showValidationMessage('JSON inválido');
          return false;
        }
      }
    });
    if (!raw) return;
    let added = 0;
    (raw.phrases || []).forEach(p => {
      if (!p.hanzi) return;
      isl.phrases.push({
        id: uid(),
        hanzi: p.hanzi,
        pinyin: p.pinyin || getPinyin(p.hanzi),
        translation: p.translation || '',
        plays: 0
      });
      added++;
    });
    (raw.words || []).forEach(w => {
      if (!w.hanzi) return;
      isl.words.push({
        id: uid(),
        hanzi: w.hanzi,
        pinyin: w.pinyin || getPinyin(w.hanzi),
        translation: w.translation || '',
        plays: 0,
        reviews: 0,
        ease: 2.5,
        interval: 0,
        due: today()
      });
      added++;
    });
    save();
    renderIsland();
    toast(`${added} itens importados`, 'success');
  }

  // ---------- Play All ----------
  function playAllPhrases() {
    const isl = getIsland();
    if (!isl || !isl.phrases.length) {
      toast('Nenhuma frase nesta ilha');
      return;
    }
    stopSpeak();
    playQueue = isl.phrases.map(p => p.hanzi);
    playIndex = 0;
    playing = true;
    $('#btn-global-play').style.display = 'none';
    $('#btn-stop').style.display = '';
    playNext();
  }

  function playNext() {
    if (!playing || !playQueue.length) {
      stopSpeak();
      return;
    }
    if (playIndex >= playQueue.length) playIndex = 0; // loop
    const text = playQueue[playIndex];
    const rows = $$('#phrases-list .item-row');
    rows.forEach((r, i) => r.classList.toggle('playing', i === playIndex));
    speak(text, () => {
      recordPlay(currentIslandId);
      const isl = getIsland();
      if (isl && isl.phrases[playIndex]) {
        isl.phrases[playIndex].plays = (isl.phrases[playIndex].plays || 0) + 1;
        save();
      }
      playIndex++;
      if (playing) setTimeout(playNext, 400);
    });
  }

  // ---------- Flashcards ----------
  function collectItems(sourceId, type) {
    let islands = sourceId === 'all' ? state.islands : state.islands.filter(i => i.id === sourceId);
    let items = [];
    islands.forEach(isl => {
      const arr = type === 'words' ? (isl.words || []) : (isl.phrases || []);
      arr.forEach(it => items.push({ ...it, islandId: isl.id, islandName: isl.name, type }));
    });
    return items;
  }

  function renderFcSetup() {
    const sel = $('#fc-source');
    const cur = sel.value;
    sel.innerHTML = '<option value="all">Todas as ilhas</option>' +
      state.islands.map(i => `<option value="${i.id}">${esc(i.name)}</option>`).join('');
    if ([...sel.options].some(o => o.value === cur)) sel.value = cur;

    const items = collectItems(sel.value, fcType);
    $('#fc-total').textContent = items.length;
    const due = items.filter(i => !i.due || i.due <= today()).length;
    $('#fc-due').textContent = due || items.length;
    $('#btn-start-fc').disabled = items.length === 0;

    $$('.chip[data-fc-type]').forEach(c => c.classList.toggle('active', c.dataset.fcType === fcType));
  }

  function startFc() {
    const source = $('#fc-source').value;
    let items = collectItems(source, fcType);
    // prefer due, then shuffle
    items = items.sort((a, b) => {
      const da = a.due || '1970-01-01';
      const db = b.due || '1970-01-01';
      return da.localeCompare(db);
    });
    // simple shuffle of top portion
    fcQueue = items.slice(0, 30); // session size
    for (let i = fcQueue.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [fcQueue[i], fcQueue[j]] = [fcQueue[j], fcQueue[i]];
    }
    fcIndex = 0;
    $('#fc-setup').classList.add('hidden');
    $('#fc-session').classList.remove('hidden');
    showCard();
  }

  function showCard() {
    if (fcIndex >= fcQueue.length) {
      endFc(true);
      return;
    }
    const item = fcQueue[fcIndex];
    $('#fc-current').textContent = fcIndex + 1;
    $('#fc-session-total').textContent = fcQueue.length;
    $('#fc-progress').style.width = ((fcIndex / fcQueue.length) * 100) + '%';
    $('#fc-front').textContent = item.hanzi;
    $('#fc-pinyin').textContent = item.pinyin || getPinyin(item.hanzi);
    $('#fc-trans').textContent = item.translation || '—';
    $('#flashcard').classList.remove('flipped');
  }

  function rateCard(hard) {
    const item = fcQueue[fcIndex];
    // update original in state
    const isl = state.islands.find(i => i.id === item.islandId);
    if (isl) {
      const arr = item.type === 'words' ? isl.words : isl.phrases;
      const orig = arr.find(x => x.id === item.id);
      if (orig) {
        orig.reviews = (orig.reviews || 0) + 1;
        if (hard) {
          orig.interval = 0;
          orig.due = today();
          orig.ease = Math.max(1.3, (orig.ease || 2.5) - 0.2);
        } else {
          orig.interval = (orig.interval || 0) < 1 ? 1 : Math.round((orig.interval || 1) * (orig.ease || 2.5));
          const d = new Date();
          d.setDate(d.getDate() + (orig.interval || 1));
          orig.due = d.toISOString().slice(0, 10);
          orig.ease = Math.min(3.0, (orig.ease || 2.5) + 0.1);
        }
      }
    }
    recordReview(!hard);
    fcIndex++;
    showCard();
  }

  function endFc(completed) {
    $('#fc-session').classList.add('hidden');
    $('#fc-setup').classList.remove('hidden');
    renderFcSetup();
    if (completed) toast('Sessão concluída!', 'success');
  }

  // ---------- Stats ----------
  function islandMastery(isl) {
    const words = isl.words || [];
    const phrases = isl.phrases || [];
    const total = words.length + phrases.length;
    if (!total) return { pct: 0, mastered: 0, learning: 0, new: total, plays: 0, reviews: 0 };
    let mastered = 0, learning = 0, newCount = 0, plays = 0, reviews = 0;
    words.forEach(w => {
      plays += w.plays || 0;
      reviews += w.reviews || 0;
      if ((w.interval || 0) >= 21) mastered++;
      else if ((w.reviews || 0) > 0) learning++;
      else newCount++;
    });
    phrases.forEach(p => {
      plays += p.plays || 0;
      reviews += p.reviews || 0;
      // phrases: mastery by plays threshold
      if ((p.plays || 0) >= 10) mastered++;
      else if ((p.plays || 0) > 0 || (p.reviews || 0) > 0) learning++;
      else newCount++;
    });
    const pct = Math.round((mastered / total) * 100);
    return { pct, mastered, learning, new: newCount, plays, reviews, total };
  }

  function renderStats() {
    updateStreak();
    const s = state.stats;
    const totalItems = state.islands.reduce((a, i) => a + (i.phrases?.length || 0) + (i.words?.length || 0), 0);
    let globalMastered = 0;
    state.islands.forEach(isl => { globalMastered += islandMastery(isl).mastered; });
    $('#stats-overview').innerHTML = `
      <div class="stat-card"><div class="stat-value">${s.totalPlays}</div><div class="stat-label">Plays totais</div></div>
      <div class="stat-card"><div class="stat-value">${s.totalReviews}</div><div class="stat-label">Reviews</div></div>
      <div class="stat-card"><div class="stat-value">${s.streak}</div><div class="stat-label">Streak (dias)</div></div>
      <div class="stat-card"><div class="stat-value">${globalMastered}/${totalItems}</div><div class="stat-label">Dominados</div></div>
    `;

    // 7-day chart
    const days = [];
    const labels = [];
    let max = 1;
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      const day = s.daily[key] || { plays: 0, reviews: 0 };
      const val = day.plays + day.reviews;
      days.push(val);
      max = Math.max(max, val);
      labels.push(d.toLocaleDateString('pt-BR', { weekday: 'short' }).slice(0, 3));
    }
    $('#activity-chart').innerHTML = days.map((v, i) => {
      const h = Math.max(4, (v / max) * 80);
      const active = i === 6 ? 'active' : '';
      return `<div class="chart-col ${active}" style="height:${h}px" title="${v}"></div>`;
    }).join('');
    $('#activity-labels').innerHTML = labels.map(l => `<span style="flex:1">${l}</span>`).join('');

    // Island mastery detail
    const masteryEl = $('#island-mastery');
    if (!state.islands.length) {
      masteryEl.innerHTML = '<p class="text-sm text-muted">Sem ilhas ainda</p>';
    } else {
      masteryEl.innerHTML = state.islands.map(isl => {
        const m = islandMastery(isl);
        const cls = m.pct >= 70 ? 'high' : m.pct >= 30 ? 'mid' : 'low';
        return `
          <div class="mastery-row">
            <div class="mastery-label">
              <span>${esc(isl.name)}</span>
              <span class="text-accent">${m.pct}% · ${m.mastered}/${m.total}</span>
            </div>
            <div class="mastery-bar"><div class="mastery-fill ${cls}" style="width:${m.pct}%"></div></div>
            <div class="text-xs text-muted mt-8">${m.mastered} dominados · ${m.learning} aprendendo · ${m.new} novos · ${m.plays} plays · ${m.reviews} reviews</div>
          </div>`;
      }).join('');
    }

    // Top islands
    const ranked = state.islands
      .map(i => ({ name: i.name, plays: s.islandPlays[i.id] || 0 }))
      .sort((a, b) => b.plays - a.plays)
      .slice(0, 5);
    $('#top-islands').innerHTML = ranked.length
      ? ranked.map((r, i) => `
          <div class="flex-between" style="padding:8px 0;border-bottom:1px solid var(--border)">
            <span>${i + 1}. ${esc(r.name)}</span>
            <span class="text-accent">${r.plays} plays</span>
          </div>`).join('')
      : '<p class="text-sm text-muted">Sem dados ainda</p>';

    // FC stats detailed
    let mastered = 0, learning = 0, newW = 0, totalW = 0;
    state.islands.forEach(isl => {
      (isl.words || []).forEach(w => {
        totalW++;
        if ((w.interval || 0) >= 21) mastered++;
        else if ((w.reviews || 0) > 0) learning++;
        else newW++;
      });
    });
    $('#fc-stats').innerHTML = `
      <div class="flex-between text-sm" style="padding:6px 0"><span>Reviews de cards</span><span class="text-accent">${s.totalReviews}</span></div>
      <div class="flex-between text-sm" style="padding:6px 0"><span>Palavras dominadas (≥21d)</span><span class="text-accent">${mastered}</span></div>
      <div class="flex-between text-sm" style="padding:6px 0"><span>Em aprendizado</span><span class="text-accent">${learning}</span></div>
      <div class="flex-between text-sm" style="padding:6px 0"><span>Novas (0 reviews)</span><span class="text-accent">${newW}</span></div>
      <div class="flex-between text-sm" style="padding:6px 0"><span>Total de palavras</span><span class="text-accent">${totalW}</span></div>
    `;
  }

  // ---------- Export / Import ----------
  function exportData() {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `language-islands-${today()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast('Exportado', 'success');
  }

  async function importData(replace) {
    const raw = $('#import-json').value.trim();
    if (!raw) { toast('Cole um JSON primeiro', 'error'); return; }
    let data;
    try { data = JSON.parse(raw); } catch {
      await Swal.fire({ title: 'JSON inválido', icon: 'error', confirmButtonColor: '#f59e0b', background: '#1e293b', color: '#f1f5f9' });
      return;
    }
    if (replace) {
      const ok = await confirmDelete('Substituir TODOS os dados atuais?');
      if (!ok) return;
      state = {
        islands: data.islands || [],
        stats: data.stats || state.stats,
        settings: data.settings || state.settings
      };
    } else {
      // merge islands by name or append
      (data.islands || []).forEach(ni => {
        const existing = state.islands.find(i => i.name === ni.name);
        if (existing) {
          existing.phrases.push(...(ni.phrases || []).map(p => ({ ...p, id: uid() })));
          existing.words.push(...(ni.words || []).map(w => ({ ...w, id: uid() })));
        } else {
          ni.id = uid();
          (ni.phrases || []).forEach(p => p.id = uid());
          (ni.words || []).forEach(w => w.id = uid());
          state.islands.push(ni);
        }
      });
      if (data.stats) {
        state.stats.totalPlays += data.stats.totalPlays || 0;
        state.stats.totalReviews += data.stats.totalReviews || 0;
      }
    }
    save();
    $('#import-json').value = '';
    toast(replace ? 'Dados substituídos' : 'Dados mesclados', 'success');
    showScreen('home');
  }

  async function resetAll() {
    const ok = await confirmDelete('Apagar TODOS os dados permanentemente?');
    if (!ok) return;
    state = {
      islands: [],
      stats: { totalPlays: 0, totalReviews: 0, daily: {}, islandPlays: {}, streak: 0, lastActive: null },
      settings: { revealDefault: false }
    };
    save();
    toast('Dados limpos', 'success');
    showScreen('home');
  }

  // ---------- Helpers ----------
  function esc(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function escAttr(s) {
    return esc(s).replace(/'/g, '&#39;');
  }

  // ---------- Events ----------
  function bind() {
    // Tabs
    $$('.tab').forEach(t => t.addEventListener('click', () => showScreen(t.dataset.screen)));

    // Home
    $('#btn-new-island').addEventListener('click', createIsland);
    $('#btn-new-island-empty')?.addEventListener('click', createIsland);

    // Island
    $('#btn-back-home').addEventListener('click', () => { stopSpeak(); showScreen('home'); });
    $('#btn-edit-island').addEventListener('click', editIsland);
    $('#btn-add-phrase').addEventListener('click', addPhrase);
    $('#btn-add-word').addEventListener('click', addWord);
    $('#btn-batch-import').addEventListener('click', batchImport);
    $('#btn-toggle-reveal').addEventListener('click', () => {
      revealAll = !revealAll;
      renderIsland();
    });
    $('#btn-play-all').addEventListener('click', playAllPhrases);
    $$('.chip[data-filter]').forEach(c => {
      c.addEventListener('click', () => {
        filter = c.dataset.filter;
        renderIsland();
      });
    });

    // Global play/stop
    $('#btn-global-play').addEventListener('click', () => {
      if (currentIslandId && $('#screen-island').classList.contains('active')) playAllPhrases();
      else toast('Abra uma ilha primeiro');
    });
    $('#btn-stop').addEventListener('click', stopSpeak);

    // Flashcards
    $('#fc-source').addEventListener('change', renderFcSetup);
    $$('.chip[data-fc-type]').forEach(c => {
      c.addEventListener('click', () => {
        fcType = c.dataset.fcType;
        renderFcSetup();
      });
    });
    $('#btn-start-fc').addEventListener('click', startFc);
    $('#btn-end-fc').addEventListener('click', () => endFc(false));
    $('#flashcard').addEventListener('click', () => {
      const card = $('#flashcard');
      const willShowBack = !card.classList.contains('flipped');
      card.classList.toggle('flipped');
      if (willShowBack) {
        const item = fcQueue[fcIndex];
        if (item) speak(item.hanzi);
      }
    });
    $('#btn-fc-hard').addEventListener('click', () => rateCard(true));
    $('#btn-fc-easy').addEventListener('click', () => rateCard(false));

    // Manage
    $('#btn-export').addEventListener('click', exportData);
    $('#btn-import-merge').addEventListener('click', () => importData(false));
    $('#btn-import-replace').addEventListener('click', () => importData(true));
    $('#btn-reset').addEventListener('click', resetAll);

    // Voice + volume settings
    const voiceSel = $('#voice-select');
    if (voiceSel) {
      voiceSel.addEventListener('change', () => {
        state.settings.voice = voiceSel.value;
        save();
        toast('Voz salva', 'success');
      });
    }
    const volSlider = $('#volume-slider');
    const volVal = $('#volume-val');
    if (volSlider) {
      const v = Math.round((state.settings.volume ?? 0.9) * 100);
      volSlider.value = v;
      if (volVal) volVal.textContent = v + '%';
      volSlider.addEventListener('input', () => {
        const pct = +volSlider.value;
        state.settings.volume = pct / 100;
        if (volVal) volVal.textContent = pct + '%';
        save();
      });
    }
    $('#btn-test-voice')?.addEventListener('click', () => {
      speak('你好，这是测试语音。');
    });
  }

  // ---------- Init ----------
  load();
  bind();
  loadVoices();
  if (synth) {
    synth.addEventListener('voiceschanged', loadVoices);
  }
  showScreen('home');

  // Seed example if empty (optional, comment out for production)
  if (!state.islands.length) {
    // silent seed for demo
    const demo = {
      id: uid(),
      name: 'Cumprimentos',
      description: 'Frases básicas de saudação',
      phrases: [
        { id: uid(), hanzi: '你好', pinyin: getPinyin('你好'), translation: 'Olá', plays: 0 },
        { id: uid(), hanzi: '早上好', pinyin: getPinyin('早上好'), translation: 'Bom dia', plays: 0 },
        { id: uid(), hanzi: '晚上好', pinyin: getPinyin('晚上好'), translation: 'Boa noite', plays: 0 },
        { id: uid(), hanzi: '谢谢', pinyin: getPinyin('谢谢'), translation: 'Obrigado', plays: 0 },
        { id: uid(), hanzi: '再见', pinyin: getPinyin('再见'), translation: 'Tchau', plays: 0 }
      ],
      words: [
        { id: uid(), hanzi: '你', pinyin: getPinyin('你'), translation: 'você', plays: 0, reviews: 0, ease: 2.5, interval: 0, due: today() },
        { id: uid(), hanzi: '好', pinyin: getPinyin('好'), translation: 'bom / bem', plays: 0, reviews: 0, ease: 2.5, interval: 0, due: today() },
        { id: uid(), hanzi: '谢谢', pinyin: getPinyin('谢谢'), translation: 'obrigado', plays: 0, reviews: 0, ease: 2.5, interval: 0, due: today() }
      ],
      createdAt: Date.now()
    };
    state.islands.push(demo);
    save();
    renderHome();
  }
})();