(() => {
  'use strict';

  const liveRegion = document.querySelector('#live-region');
  const skipLink = document.querySelector('.skip-link');
  const form = document.querySelector('#onboarding-form');
  const onboarding = document.querySelector('#onboarding');
  const wizardSteps = [...document.querySelectorAll('.wizard-step')];
  const progressText = document.querySelector('#wizard-progress');
  const progressBar = document.querySelector('#wizard-progressbar');
  const previousButton = document.querySelector('#wizard-prev');
  const nextButton = document.querySelector('#wizard-next');
  const submitButton = document.querySelector('#run-analysis');
  const regionInput = document.querySelector('#region-input');
  const cropSettings = document.querySelector('#crop-settings');
  const growthSettings = document.querySelector('#growth-settings');
  const growthPhoto = document.querySelector('#growth-photo');
  const growthPhotoPreview = document.querySelector('#growth-photo-preview');
  const growthPhotoImage = document.querySelector('#growth-photo-image');
  let currentStep = 1;
  let photoPreviewUrl = null;
  let wizardCanReturn = false;
  let wizardReturnFocus = null;
  let wizardReturnProfileState = 'ready';
  const cropSettingsState = {};
  const cropGrowthState = {};

  const labels = {
    situation: { planning: '재배 전 환경 분석', growing: '재배 중 생육 점검' },
    crop: { apple: '사과', pear: '배', cucumber: '오이', potato: '감자', lettuce: '상추' },
    cultivation: { outdoor: '노지', 'facility-soil': '시설흙', 'facility-water': '시설물', unknown: '잘 모름' },
    season: {
      spring: '봄 작기',
      summer: '여름 작기',
      'highland-summer': '고랭지 여름 작기',
      autumn: '가을 작기',
      'autumn-winter': '가을·겨울 작기',
      unknown: '잘 모름'
    },
    growth: {
      early: '초기 생육',
      middle: '한창 자라는 중',
      harvest: '수확 무렵',
      unknown: '잘 모름',
      flowering: '꽃이 피는 중',
      'tuber-bulking': '감자알이 굵어지는 중',
      'flower-differentiation': '꽃눈이 생기기 시작함'
    }
  };

  let lastDialogTrigger = null;

  function announce(message) {
    liveRegion.textContent = '';
    requestAnimationFrame(() => { liveRegion.textContent = message; });
  }

  function selectedValue(name) {
    return form.querySelector(`input[name="${name}"]:checked`)?.value || '';
  }

  function selectedValues(name) {
    return [...form.querySelectorAll(`input[name="${name}"]:checked`)].map((input) => input.value);
  }

  function setError(id, visible) {
    const element = document.querySelector(`#${id}`);
    if (element) element.hidden = !visible;
  }

  function cropSettingsComplete() {
    return selectedValues('crop').every((crop) => {
      if (crop === 'cucumber' || crop === 'lettuce') {
        return Boolean(
          selectedValue(`cultivation-${crop}`) &&
          selectedValue(`season-${crop}`)
        );
      }
      if (crop === 'potato') return Boolean(selectedValue(`season-${crop}`));
      return true;
    });
  }

  function growthSettingsComplete() {
    if (selectedValue('situation') === 'planning') return true;
    const crops = selectedValues('crop');
    return crops.length > 0 && crops.every((crop) => Boolean(selectedValue(`growth-${crop}`)));
  }

  function isStepComplete(step) {
    if (step === 1) return regionInput.dataset.candidateVerified === 'true';
    if (step === 2) return selectedValues('crop').length > 0;
    if (step === 3) return cropSettingsComplete();
    if (step === 4) return growthSettingsComplete();
    return true;
  }

  function validateStep(step) {
    const complete = isStepComplete(step);
    if (step === 1) setError('region-error', regionInput.dataset.candidateVerified !== 'true');
    if (step === 2) setError('crop-error', selectedValues('crop').length === 0);
    if (step === 3) {
      const selectedCrops = selectedValues('crop');
      setError('cultivation-error', selectedCrops.some((crop) =>
        (['cucumber', 'lettuce'].includes(crop) && !selectedValue(`cultivation-${crop}`)) ||
        (['cucumber', 'potato', 'lettuce'].includes(crop) && !selectedValue(`season-${crop}`))));
    }
    if (step === 4) setError('growth-error', !growthSettingsComplete());
    if (!complete) announce('선택하지 않은 항목이 있습니다. 안내 문구를 확인해 주세요.');
    return complete;
  }

  function updateNextState() {
    nextButton.disabled = !isStepComplete(currentStep);
  }

  function updateReview() {
    const selectedCrops = selectedValues('crop');
    const planning = selectedValue('situation') === 'planning';
    document.querySelector('#review-growth-row').hidden = planning;
    document.querySelector('#review-situation').textContent = planning
      ? '재배 전 환경 분석'
      : '재배 중 생육 점검';
    document.querySelector('#review-region').textContent =
      regionInput.dataset.candidateVerified === 'true'
        ? regionInput.value.trim()
        : '위치 확인 필요';
    document.querySelector('#review-crop').textContent =
      selectedCrops.map((crop) => labels.crop[crop]).join(', ') || '선택 전';
    document.querySelector('#review-season').textContent =
      selectedCrops.map(cropSettingSummary).join(' · ') || '선택 전';
    document.querySelector('#review-growth').textContent = planning
      ? '재배 전 환경 분석 · 생육 단계 입력 없음'
      : `${selectedCrops.map(growthSettingSummary).join(' · ') || '단계 미선택'}${growthPhoto.files?.length ? ' · 사진 추가됨' : ''}`;
  }

  function wizardRoute() {
    return selectedValue('situation') === 'planning'
      ? [1, 2, 3, 5]
      : [1, 2, 3, 4, 5];
  }

  function setStep(step, shouldFocus = true) {
    currentStep = Math.max(1, Math.min(5, step));
    const route = wizardRoute();
    if (!route.includes(currentStep)) {
      currentStep = route.find((itemStep) => itemStep > currentStep) ?? route.at(-1);
    }
    const routePosition = route.indexOf(currentStep) + 1;
    wizardSteps.forEach((section) => { section.hidden = Number(section.dataset.step) !== currentStep; });
    document.querySelectorAll('.wizard-step-list li').forEach((item, index) => {
      const itemStep = index + 1;
      const visiblePosition = route.indexOf(itemStep);
      item.hidden = visiblePosition === -1;
      if (visiblePosition >= 0) item.dataset.stepNumber = String(visiblePosition + 1);
      item.classList.toggle('is-current', itemStep === currentStep);
      item.classList.toggle('is-complete', itemStep < currentStep);
      if (itemStep === currentStep) item.setAttribute('aria-current', 'step');
      else item.removeAttribute('aria-current');
    });
    progressText.textContent = `${routePosition} / ${route.length}`;
    progressBar.max = route.length;
    progressBar.value = routePosition;
    progressBar.textContent = `${routePosition} / ${route.length}`;
    const isFirstStep = routePosition === 1;
    previousButton.disabled = isFirstStep && !wizardCanReturn;
    previousButton.textContent = isFirstStep && wizardCanReturn ? '돌아가기' : '이전';
    nextButton.hidden = currentStep === 5;
    submitButton.hidden = currentStep !== 5;
    if (currentStep === 4) renderGrowthSettings();
    if (currentStep === 5) updateReview();
    updateNextState();
    if (shouldFocus) {
      const heading = document.querySelector(`.wizard-step[data-step="${currentStep}"] h1`);
      heading?.focus({ preventScroll: true });
      document.querySelector('.wizard-overlay')?.scrollTo({ top: 0 });
    }
  }

  function createChoice(name, value, title, help, checked = false) {
    const label = document.createElement('label');
    label.className = 'choice-card';
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = name;
    input.value = value;
    input.dataset.label = title;
    input.checked = checked;
    const span = document.createElement('span');
    const strong = document.createElement('strong');
    strong.textContent = title;
    const small = document.createElement('small');
    small.textContent = help;
    span.append(strong, small);
    label.append(input, span);
    return label;
  }

  function createGrowthChoice(crop, value, title, help, dateReference, checked) {
    const label = createChoice(`growth-${crop}`, value, title, help, checked);
    const strong = label.querySelector('strong');
    const titleRow = document.createElement('span');
    titleRow.className = 'choice-title-row';
    strong.replaceWith(titleRow);
    titleRow.append(strong);
    if (dateReference) {
      const badge = document.createElement('span');
      badge.className = 'choice-recommendation';
      badge.textContent = '날짜 기준 AI 예상';
      titleRow.append(badge);
    }
    return label;
  }

  function rememberCropSettings() {
    Object.keys(labels.crop).forEach((crop) => {
      cropSettingsState[crop] = {
        cultivation: selectedValue(`cultivation-${crop}`) || cropSettingsState[crop]?.cultivation || '',
        season: selectedValue(`season-${crop}`) || cropSettingsState[crop]?.season || 'unknown'
      };
    });
  }

  function renderCropSettings() {
    rememberCropSettings();
    const planning = selectedValue('situation') === 'planning';
    document.querySelector('#settings-step-help').textContent = planning
      ? '작물의 재배기간을 확인해 후보 지역의 기후와 토양을 비교합니다.'
      : '재배 환경과 작기를 작물별로 확인합니다. 잘 모르면 가까운 예보만 먼저 볼 수 있습니다.';
    const cards = selectedValues('crop').map((crop) => {
      const card = document.createElement('section');
      card.className = 'crop-setting-card';
      const title = document.createElement('h2');
      title.textContent = labels.crop[crop];
      const help = document.createElement('p');
      help.textContent = crop === 'cucumber' || crop === 'lettuce'
        ? '재배 환경에 따라 기상·토양 판단 범위가 달라집니다.'
        : '재배 환경은 노지로 적용합니다.';
      card.append(title, help);
      if (crop === 'cucumber' || crop === 'lettuce') {
        const cultivation = document.createElement('fieldset');
        cultivation.className = 'settings-group';
        const legend = document.createElement('legend');
        legend.textContent = `${labels.crop[crop]} 재배 환경`;
        const grid = document.createElement('div');
        grid.className = 'choice-grid';
        grid.append(
          createChoice(`cultivation-${crop}`, 'outdoor', '노지', '야외 밭', !cropSettingsState[crop]?.cultivation || cropSettingsState[crop]?.cultivation === 'outdoor'),
          createChoice(`cultivation-${crop}`, 'facility-soil', '시설흙', '비닐하우스 토양', cropSettingsState[crop]?.cultivation === 'facility-soil'),
          createChoice(`cultivation-${crop}`, 'facility-water', '시설물', '양액·수경 시설', cropSettingsState[crop]?.cultivation === 'facility-water')
        );
        cultivation.append(legend, grid);
        card.append(cultivation);
      }
      if (['cucumber', 'potato', 'lettuce'].includes(crop)) {
        const season = document.createElement('fieldset');
        season.className = 'settings-group';
        const legend = document.createElement('legend');
        legend.textContent = `${labels.crop[crop]} 재배기간`;
        const grid = document.createElement('div');
        grid.className = 'choice-grid';
        const choices = crop === 'potato'
          ? [
              ['spring', '봄 작기', '3~6월'],
              ['highland-summer', '고랭지 여름 작기', '4~9월'],
              ['autumn', '가을 작기', '7~11월']
            ]
          : [
              ['spring', '봄 작기', '3~5월'],
              ['summer', '여름 작기', '6~8월'],
              ['autumn-winter', '가을·겨울 작기', '9~2월']
            ];
        choices.push(['unknown', '잘 모름', '장기 기후는 보류하고 가까운 예보만 확인']);
        choices.forEach(([value, title, help]) => {
          grid.append(createChoice(
            `season-${crop}`,
            value,
            title,
            help,
            (cropSettingsState[crop]?.season || 'unknown') === value
          ));
        });
        season.append(legend, grid);
        card.append(season);
      }
      const dateNote = document.createElement('div');
      dateNote.className = 'auto-date-note';
      const dateLabel = new Intl.DateTimeFormat('ko-KR', {
        year: 'numeric',
        month: 'long',
        day: 'numeric'
      }).format(new Date());
      const dateCheck = document.createElement('span');
      dateCheck.setAttribute('aria-hidden', 'true');
      dateCheck.textContent = '✓';
      const dateCopy = document.createElement('div');
      const dateTitle = document.createElement('strong');
      dateTitle.textContent = `${dateLabel} · 예보 기준일`;
      const dateHelp = document.createElement('p');
      dateHelp.textContent = '오늘부터의 예보를 확인합니다. 재배기간은 위에서 별도로 선택합니다.';
      dateCopy.append(dateTitle, dateHelp);
      dateNote.append(dateCheck, dateCopy);
      card.append(dateNote);
      return card;
    });
    cropSettings.replaceChildren(...cards);
    updateNextState();
  }

  function rememberCropGrowth() {
    Object.keys(labels.crop).forEach((crop) => {
      const growth = selectedValue(`growth-${crop}`);
      if (growth) cropGrowthState[crop] = growth;
    });
  }

  function recommendedGrowthStage(crop, month = new Date().getMonth() + 1) {
    const profiles = {
      apple: { early: [3, 4, 5], middle: [6, 7, 8], harvest: [9, 10, 11] },
      pear: { early: [3, 4, 5], middle: [6, 7, 8], harvest: [9, 10, 11] },
      cucumber: { early: [3, 4], middle: [5, 6, 7, 8], harvest: [9, 10] },
      potato: { early: [3, 4], middle: [5, 6, 7, 8], harvest: [9, 10, 11] },
      lettuce: { early: [2, 3, 4], middle: [5, 6, 7, 8, 9], harvest: [10, 11] }
    };
    const profile = profiles[crop] || {};
    return Object.entries(profile).find(([, months]) => months.includes(month))?.[0] || 'unknown';
  }

  function renderGrowthSettings() {
    rememberCropGrowth();
    const planning = selectedValue('situation') === 'planning';
    document.querySelector('#growth-planning-note').hidden = !planning;
    document.querySelector('#growth-photo-card').hidden = planning;
    document.querySelector('#growth-step-title').textContent = planning
      ? '재배 전 환경 분석 조건을 확인해 주세요'
      : '작물별 현재 상태를 확인해 주세요';
    document.querySelector('#growth-step-help').textContent = planning
      ? '재배 전에는 실제 생육 단계가 없으므로 별도로 묻지 않습니다.'
      : '오늘 날짜로 예상한 단계가 기본 선택되어 있습니다. 실제 작물과 다르면 바꾸고, 모르면 잘 모름을 선택해 주세요.';
    if (planning) {
      growthSettings.replaceChildren();
      updateNextState();
      return;
    }
    const cards = selectedValues('crop').map((crop) => {
      const recommendation = recommendedGrowthStage(crop);
      const selected = cropGrowthState[crop] || recommendation;
      cropGrowthState[crop] = selected;
      const card = document.createElement('section');
      card.className = 'crop-setting-card growth-crop-card';
      const title = document.createElement('h2');
      title.textContent = labels.crop[crop];
      const help = document.createElement('p');
      help.textContent = '날짜 기준 AI 예상이 기본입니다. 실제 작물과 다르면 직접 바꿔 주세요.';
      const fieldset = document.createElement('fieldset');
      fieldset.className = 'settings-group';
      const legend = document.createElement('legend');
      legend.className = 'sr-only';
      legend.textContent = `${labels.crop[crop]} 생육단계`;
      const grid = document.createElement('div');
      grid.className = 'choice-grid';
      const choices = [
        ['early', '초기 생육', '싹·어린 잎 시기'],
        ['middle', '한창 자라는 중', '생육 중기'],
        ['harvest', '수확 무렵', '수확 준비'],
        ['unknown', '잘 모름', '단계 공통 안내']
      ];
      if (crop === 'pear') {
        choices.splice(1, 0, ['flowering', '꽃이 피는 중', '개화기 저온 확인']);
      }
      if (crop === 'potato') {
        choices.splice(2, 0, ['tuber-bulking', '감자알이 굵어지는 중', '고온 영향 확인']);
      }
      const cultivation = selectedValue(`cultivation-${crop}`);
      if (
        crop === 'lettuce' &&
        ['facility-soil', 'facility-water'].includes(cultivation)
      ) {
        choices.splice(2, 0, [
          'flower-differentiation',
          '꽃눈이 생기기 시작함',
          '고온·추대 가능성 확인'
        ]);
      }
      choices.forEach(([value, choiceTitle, choiceHelp]) => {
        grid.append(createGrowthChoice(
          crop,
          value,
          choiceTitle,
          choiceHelp,
          value === recommendation,
          value === selected
        ));
      });
      fieldset.append(legend, grid);
      card.append(title, help, fieldset);
      return card;
    });
    growthSettings.replaceChildren(...cards);
    updateNextState();
  }

  function cropSettingSummary(crop) {
    const season = labels.season[selectedValue(`season-${crop}`)] || null;
    if (!['cucumber', 'lettuce'].includes(crop)) {
      return `${labels.crop[crop]} · 노지${season ? ` · ${season}` : ' · 다년생 작물'}`;
    }
    const cultivation = labels.cultivation[selectedValue(`cultivation-${crop}`)] || '환경 미선택';
    return `${labels.crop[crop]} · ${cultivation} · ${season || '작기 미선택'}`;
  }

  function growthSettingSummary(crop) {
    const growth = selectedValue(`growth-${crop}`) || cropGrowthState[crop];
    const recommendation = recommendedGrowthStage(crop);
    const suffix = growth !== 'unknown' && growth === recommendation ? ' · 날짜 기준 AI 예상' : '';
    return `${labels.crop[crop]} · ${labels.growth[growth] || '단계 미선택'}${suffix}`;
  }

  function hasSavedFarmProfile() {
    try {
      const farmsRaw = window.localStorage?.getItem('heuknalssi.farms.v1');
      if (farmsRaw) {
        const farms = JSON.parse(farmsRaw);
        if (Array.isArray(farms) && farms.some((farm) => (
          typeof farm?.region === 'string' &&
          farm.region.trim() !== '' &&
          farm?.situation === 'growing' &&
          Array.isArray(farm?.crops) &&
          farm.crops.length > 0
        ))) return true;
      }
      const raw = window.localStorage?.getItem('heuknalssi.session.v1');
      if (!raw) return false;
      const saved = JSON.parse(raw);
      return (
        typeof saved?.region === 'string' &&
        saved.region.trim() !== '' &&
        saved?.situation === 'growing' &&
        Array.isArray(saved?.crops) &&
        saved.crops.length > 0
      );
    } catch {
      return false;
    }
  }

  function openWizard(resetValues) {
    wizardCanReturn = hasSavedFarmProfile();
    wizardReturnFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    wizardReturnProfileState = document.body.dataset.profileState || 'ready';
    document.querySelector('#save-consent').checked = false;
    if (resetValues) {
      form.reset();
      document.querySelectorAll('.validation').forEach((error) => { error.hidden = true; });
      renderCropSettings();
    }
    onboarding.hidden = false;
    document.querySelector('.app-shell').inert = true;
    skipLink.inert = true;
    document.body.classList.add('wizard-open');
    document.body.dataset.profileState = 'new';
    setStep(1);
  }

  function closeWizard() {
    if (!wizardCanReturn) return;
    onboarding.hidden = true;
    document.querySelector('.app-shell').inert = false;
    skipLink.inert = false;
    document.body.classList.remove('wizard-open');
    document.body.dataset.profileState = wizardReturnProfileState;
    document.dispatchEvent(new CustomEvent('heuknalssi:wizard-cancelled'));
    announce('변경하지 않고 대시보드로 돌아왔습니다.');
    requestAnimationFrame(() => {
      const fallback = document.querySelector('#open-new-analysis');
      const focusTarget = wizardReturnFocus?.isConnected ? wizardReturnFocus : fallback;
      focusTarget?.focus({ preventScroll: true });
    });
  }

  function openSavedFarmDashboard() {
    onboarding.hidden = true;
    document.querySelector('.app-shell').inert = false;
    skipLink.inert = false;
    document.body.classList.remove('wizard-open');
    document.body.classList.add('session-restoring');
    document.body.dataset.profileState = 'saved';
  }

  function showView(viewName) {
    document.querySelectorAll('[data-view-panel]').forEach((panel) => {
      panel.hidden = panel.dataset.viewPanel !== viewName;
    });
    document.querySelectorAll('[data-view]').forEach((button) => {
      if (button.dataset.view === viewName) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });
    const heading = document.querySelector(`[data-view-panel="${viewName}"] h1`);
    window.scrollTo({ top: 0, left: 0 });
    heading?.focus({ preventScroll: true });
    announce(`${heading?.textContent || '현재'} 화면으로 이동했습니다.`);
  }

  document.addEventListener('click', (event) => {
    const trigger = event.target instanceof Element
      ? event.target.closest('[data-open-new-farm="true"]')
      : null;
    if (!trigger) return;
    event.preventDefault();
    document.dispatchEvent(new CustomEvent('heuknalssi:new-farm-started'));
    openWizard(true);
  }, true);
  document.addEventListener('heuknalssi:open-new-farm', () => {
    document.dispatchEvent(new CustomEvent('heuknalssi:new-farm-started'));
    openWizard(true);
  });
  document.addEventListener('heuknalssi:show-services', (event) => {
    showView('services');
    const targetId = event.detail?.targetId;
    if (typeof targetId !== 'string') return;
    requestAnimationFrame(() => {
      const target = document.getElementById(targetId);
      if (!target) return;
      target.scrollIntoView({ block: 'start' });
      target.focus({ preventScroll: true });
      announce(`${target.textContent || '추가 서비스'} 안내로 이동했습니다.`);
    });
  });

  function openEvidenceDialog(section) {
    const dialog = document.querySelector('#evidence-dialog');
    lastDialogTrigger = document.activeElement;
    dialog.showModal();
    const limits = document.querySelector('#dialog-limits');
    const guideSection = dialog.querySelector(`[data-guide-section="${section}"]`);
    if (section === 'limits' && limits) limits.focus();
    else if (guideSection) {
      guideSection.setAttribute('tabindex', '-1');
      guideSection.focus({ preventScroll: true });
      guideSection.scrollIntoView({ block: 'start' });
    } else dialog.querySelector('[data-close-dialog]')?.focus();
  }

  function trapDialogFocus(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.currentTarget.close();
      return;
    }
    if (event.key !== 'Tab') return;
    const dialog = event.currentTarget;
    const focusable = [...dialog.querySelectorAll('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])')]
      .filter((element) => !element.hidden);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  document.querySelectorAll('[data-view]').forEach((button) => {
    button.addEventListener('click', () => showView(button.dataset.view));
  });

  document.querySelectorAll('[data-open-dialog]').forEach((button) => {
    button.addEventListener('click', () => openEvidenceDialog(button.dataset.openDialog));
  });

  const evidenceDialog = document.querySelector('#evidence-dialog');
  evidenceDialog.addEventListener('keydown', trapDialogFocus);
  evidenceDialog.querySelector('[data-close-dialog]').addEventListener('click', () => evidenceDialog.close());
  evidenceDialog.addEventListener('click', (event) => {
    if (event.target === evidenceDialog) evidenceDialog.close();
  });
  evidenceDialog.addEventListener('close', () => {
    if (lastDialogTrigger instanceof HTMLElement) lastDialogTrigger.focus();
  });

  const commandDialog = document.querySelector('#command-dialog');
  const commandTrigger = document.querySelector('#command-trigger');
  const commandClose = document.querySelector('#command-close');

  function openCommandDialog() {
    if (window.matchMedia('(max-width: 920px)').matches || !onboarding.hidden || evidenceDialog.open) return;
    if (commandDialog.open) {
      commandDialog.close();
      return;
    }
    commandDialog.showModal();
    commandTrigger.setAttribute('aria-expanded', 'true');
    commandDialog.querySelector('[data-command]')?.focus();
  }

  commandTrigger.addEventListener('click', openCommandDialog);
  commandClose.addEventListener('click', () => commandDialog.close());
  commandDialog.addEventListener('keydown', trapDialogFocus);
  commandDialog.addEventListener('click', (event) => {
    if (event.target === commandDialog) commandDialog.close();
  });
  commandDialog.addEventListener('close', () => {
    commandTrigger.setAttribute('aria-expanded', 'false');
    commandTrigger.focus();
  });
  document.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      openCommandDialog();
    }
  });
  commandDialog.querySelectorAll('[data-command]').forEach((button) => {
    button.addEventListener('click', () => {
      const command = button.dataset.command;
      commandDialog.close();
      if (['dashboard', 'services', 'mypage'].includes(command)) showView(command);
      if (command === 'new-analysis') requestAnimationFrame(() => openWizard(true));
    });
  });

  document.querySelectorAll('input[name="font-size-setting"]').forEach((radio) => {
    radio.addEventListener('change', () => {
      document.body.classList.toggle('large-text', radio.value === 'large' && radio.checked);
      announce(`글자 크기를 ${radio.value === 'large' ? '크게' : '보통으로'} 바꿨습니다.`);
    });
  });

  document.querySelector('#contrast-setting').addEventListener('change', (event) => {
    document.body.classList.toggle('high-contrast', event.target.checked);
    document.querySelector('#contrast-status').textContent = `고대비 화면 ${event.target.checked ? '켜짐' : '꺼짐'}`;
    announce(`고대비 화면을 ${event.target.checked ? '켰습니다' : '껐습니다'}.`);
  });

  document.querySelector('#open-new-analysis').addEventListener('click', () => openWizard(false));

  nextButton.addEventListener('click', () => {
    if (!validateStep(currentStep)) return;
    const route = wizardRoute();
    const currentIndex = route.indexOf(currentStep);
    setStep(route[Math.min(currentIndex + 1, route.length - 1)]);
  });

  previousButton.addEventListener('click', () => {
    const route = wizardRoute();
    const currentIndex = route.indexOf(currentStep);
    if (currentIndex === 0 && wizardCanReturn) {
      closeWizard();
      return;
    }
    setStep(route[Math.max(currentIndex - 1, 0)]);
  });

  form.addEventListener('change', (event) => {
    if (event.target.name === 'situation') {
      const growing = event.target.value === 'growing';
      document.querySelector('#crop-step-title').textContent = growing
        ? '지금 키우는 작물을 모두 골라 주세요'
        : '검토할 작물을 모두 골라 주세요';
      document.querySelector('#crop-step-help').textContent = growing
        ? '여러 작물을 함께 재배한다면 복수로 선택할 수 있습니다. 분석 후 작물 탭에서 결과를 전환할 수 있습니다.'
        : '여러 작물을 비교하려면 복수로 선택할 수 있습니다. 분석 후 작물 탭에서 결과를 전환할 수 있습니다.';
      renderCropSettings();
      renderGrowthSettings();
      setStep(currentStep, false);
    }
    if (event.target.name === 'crop') {
      renderCropSettings();
      renderGrowthSettings();
    }
    if (event.target.name === 'crop') setError('crop-error', false);
    if (event.target.name.startsWith('cultivation-')) setError('cultivation-error', false);
    if (event.target.name.startsWith('season-')) setError('cultivation-error', false);
    if (event.target.name.startsWith('growth-')) {
      const crop = event.target.name.slice('growth-'.length);
      cropGrowthState[crop] = event.target.value;
      setError('growth-error', false);
    }
    updateNextState();
  });

  growthPhoto.addEventListener('change', () => {
    if (photoPreviewUrl) URL.revokeObjectURL(photoPreviewUrl);
    const [file] = growthPhoto.files || [];
    if (!file) {
      photoPreviewUrl = null;
      growthPhotoPreview.hidden = true;
      growthPhotoImage.removeAttribute('src');
      return;
    }
    if (!file.type.startsWith('image/') || file.size > 10 * 1024 * 1024) {
      growthPhoto.value = '';
      growthPhotoPreview.hidden = true;
      announce('10MB 이하 이미지 파일만 추가할 수 있습니다.');
      return;
    }
    photoPreviewUrl = URL.createObjectURL(file);
    growthPhotoImage.src = photoPreviewUrl;
    growthPhotoPreview.hidden = false;
    announce('선택한 사진을 미리 봅니다.');
  });

  regionInput.addEventListener('input', () => {
    setError('region-error', false);
    updateNextState();
  });

  document.querySelectorAll('[data-edit-step]').forEach((button) => {
    button.addEventListener('click', () => setStep(Number(button.dataset.editStep)));
  });

  renderCropSettings();
  renderGrowthSettings();
  setStep(1, false);
  if (hasSavedFarmProfile()) openSavedFarmDashboard();
  else openWizard(false);
})();
