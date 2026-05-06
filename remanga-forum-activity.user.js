// ==UserScript==
// @name         ReManga Forum Activity List
// @namespace    https://remanga.org/
// @version      1.0.8
// @description  Показывает уникальных комментаторов и лайкнувших под постом форума ReManga. Кнопка закреплена в правом нижнем углу.
// @match        https://remanga.org/forum/*
// @updateURL    https://raw.githubusercontent.com/dev-leva1/commentors-forum-list/main/remanga-forum-activity.user.js
// @downloadURL  https://raw.githubusercontent.com/dev-leva1/commentors-forum-list/main/remanga-forum-activity.user.js
// @grant        GM_xmlhttpRequest
// @connect      api.remanga.org
// @connect      remanga.org
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const SELECTORS = {
    main: 'main',
    article: 'article',
    userLink: 'a[href*="/user/"][href$="/about"]',
    dialog: '[role="dialog"], [aria-modal="true"]',
  };

  const STORAGE_KEYS = Object.freeze({
    mode: 'rm_forum_activity_mode',
    subscriptionProfiles: 'rm_forum_activity_subscription_profiles',
  });
  const MODES = Object.freeze({
    comments: 'comments',
    likes: 'likes',
    intersection: 'intersection',
  });
  const MOBILE_BREAKPOINT = 768;
  const BUTTON_CLASS = 'rmfa-trigger';
  const PANEL_CLASS = 'rmfa-panel';
  const ROOT_CLASS = 'rmfa-root';
  const STYLE_ID = 'rmfa-styles';

  class ProfileInputParser {
    parse(value) {
      if (typeof value !== 'string' || !value.trim()) {
        return {
          ids: [],
          invalidCount: 0,
        };
      }

      const ids = [];
      const seen = new Set();
      let invalidCount = 0;
      const parts = value.split(/[\s,;]+/).map((part) => part.trim()).filter(Boolean);

      for (const part of parts) {
        const id = this.parseProfileId(part);
        if (!id) {
          invalidCount += 1;
          continue;
        }

        if (!seen.has(id)) {
          seen.add(id);
          ids.push(id);
        }
      }

      return {
        ids,
        invalidCount,
      };
    }

    parseProfileId(value) {
      if (/^\d+$/.test(value)) {
        return this.normalizeId(value);
      }

      const relativeMatch = value.match(/^\/user\/(\d+)\/about\/?$/i);
      if (relativeMatch) {
        return this.normalizeId(relativeMatch[1]);
      }

      try {
        const url = new URL(value);
        if (url.protocol !== 'https:' || url.hostname !== 'remanga.org') {
          return null;
        }

        const match = url.pathname.match(/^\/user\/(\d+)\/about\/?$/i);
        return match ? this.normalizeId(match[1]) : null;
      } catch (_error) {
        return null;
      }
    }

    normalizeId(value) {
      const id = Number(value);
      return Number.isSafeInteger(id) && id > 0 ? id : null;
    }
  }

  class SettingsStore {
    constructor(profileInputParser = new ProfileInputParser()) {
      this.profileInputParser = profileInputParser;
    }

    getMode() {
      const value = window.localStorage.getItem(STORAGE_KEYS.mode);
      return Object.values(MODES).includes(value) ? value : MODES.comments;
    }

    setMode(mode) {
      if (!Object.values(MODES).includes(mode)) {
        return;
      }

      window.localStorage.setItem(STORAGE_KEYS.mode, mode);
    }

    getSubscriptionProfilesInput() {
      return window.localStorage.getItem(STORAGE_KEYS.subscriptionProfiles) || '';
    }

    setSubscriptionProfilesInput(value) {
      window.localStorage.setItem(STORAGE_KEYS.subscriptionProfiles, typeof value === 'string' ? value : '');
    }

    getSubscriptionProfileParseResult() {
      return this.profileInputParser.parse(this.getSubscriptionProfilesInput());
    }
  }

  class ForumPageDetector {
    getPostPath() {
      return window.location.pathname.replace(/\/+$/, '');
    }

    isForumPostPage() {
      const path = this.getPostPath();
      return /^\/forum\/[^/]+$/.test(path) && path !== '/forum/feed';
    }

    getSlug() {
      if (!this.isForumPostPage()) {
        return null;
      }

      return this.getPostPath().replace(/^\/forum\//, '');
    }

    getPostId() {
      const sources = [document.title, document.body?.innerText ?? '', document.documentElement?.outerHTML ?? ''];

      for (const source of sources) {
        const match = source.match(/Пост номер\s+(\d+)/i) || source.match(/post_id[^\d]{0,20}(\d{3,})/i);
        if (match) {
          return match[1];
        }
      }

      return null;
    }
  }

  class ApiClient {
    async fetchComments(postId) {
      const users = new Map();
      let page = 1;

      while (true) {
        const url = new URL('https://api.remanga.org/api/v2/activity/comments/');
        url.searchParams.set('page', String(page));
        url.searchParams.set('post_id', String(postId));

        const response = await this.requestJson(url.toString());
        if (!Array.isArray(response) || response.length === 0) {
          break;
        }

        for (const entry of response) {
          const user = this.normalizeUser(entry?.user);
          if (user) {
            users.set(user.id, user);
          }
        }

        page += 1;
      }

      return Array.from(users.values());
    }

    async fetchLikes(slug) {
      const users = new Map();
      const baseUrl = new URL(`https://api.remanga.org/api/v2/forum/${encodeURIComponent(slug)}/reactions/`);
      baseUrl.searchParams.set('count', '50');
      baseUrl.searchParams.set('type', '0');
      let page = 1;

      while (page) {
        const requestUrl = new URL(baseUrl.toString());
        requestUrl.searchParams.set('page', String(page));
        const response = await this.requestJson(requestUrl.toString());
        const items = Array.isArray(response?.results) ? response.results : [];

        for (const entry of items) {
          const user = this.normalizeUser(entry?.user);
          if (user) {
            users.set(user.id, user);
          }
        }

        if (!response?.next || items.length === 0) {
          break;
        }

        page = this.parseNextPage(response.next, page);
      }

      return Array.from(users.values());
    }

    async fetchFollowers(profileId) {
      const id = Number(profileId);
      if (!Number.isSafeInteger(id) || id <= 0) {
        throw new Error('Invalid profile id');
      }

      const users = new Map();
      const baseUrl = new URL('https://api.remanga.org/api/v2/users/followers/');
      baseUrl.searchParams.set('count', '50');
      baseUrl.searchParams.set('id', String(id));
      baseUrl.searchParams.set('sub_type', 'author_users');
      let page = 1;

      while (page) {
        const requestUrl = new URL(baseUrl.toString());
        requestUrl.searchParams.set('page', String(page));
        const response = await this.requestJson(requestUrl.toString());
        const items = Array.isArray(response?.results) ? response.results : [];

        for (const entry of items) {
          const user = this.normalizeUser(entry);
          if (user) {
            users.set(user.id, user);
          }
        }

        if (!response?.next || items.length === 0) {
          break;
        }

        page = this.parseNextPage(response.next, page);
      }

      return Array.from(users.values());
    }

    parseNextPage(next, currentPage) {
      if (typeof next === 'number' && Number.isFinite(next) && next > currentPage) {
        return next;
      }

      if (typeof next === 'string' && /^\d+$/.test(next.trim())) {
        const page = Number(next.trim());
        return Number.isFinite(page) && page > currentPage ? page : null;
      }

      if (typeof next !== 'string' || !next.trim()) {
        return null;
      }

      try {
        const url = new URL(next, window.location.origin);
        const page = Number(url.searchParams.get('page'));
        return Number.isFinite(page) && page > currentPage ? page : null;
      } catch (_error) {
        return null;
      }
    }

    async requestJson(url) {
      if (typeof GM_xmlhttpRequest === 'function') {
        return this.requestJsonWithUserscriptApi(url);
      }

      const response = await fetch(url, {
        credentials: 'omit',
        mode: 'cors',
        headers: {
          accept: 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error(`Request failed: ${response.status} ${url}`);
      }

      return response.json();
    }

    requestJsonWithUserscriptApi(url) {
      return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: 'GET',
          url,
          headers: {
            accept: 'application/json',
          },
          onload: (response) => {
            if (response.status < 200 || response.status >= 300) {
              reject(new Error(`Request failed: ${response.status} ${url}`));
              return;
            }

            try {
              resolve(JSON.parse(response.responseText));
            } catch (error) {
              reject(new Error(`Invalid JSON: ${url} ${error instanceof Error ? error.message : String(error)}`));
            }
          },
          onerror: () => {
            reject(new Error(`Network error: ${url}`));
          },
          ontimeout: () => {
            reject(new Error(`Request timeout: ${url}`));
          },
        });
      });
    }


    normalizeUser(user) {
      if (!user || typeof user !== 'object') {
        return null;
      }

      if (!Number.isFinite(Number(user.id)) || typeof user.username !== 'string' || !user.username.trim()) {
        return null;
      }

      return {
        id: Number(user.id),
        username: user.username.trim(),
        profileUrl: `https://remanga.org/user/${Number(user.id)}/about`,
        avatarUrl: this.normalizeMediaUrl(user.avatar?.mid || user.avatar?.high || null),
      };
    }

    normalizeMediaUrl(path) {
      if (!path || typeof path !== 'string') {
        return null;
      }

      if (path.startsWith('http')) {
        return path;
      }

      return path.startsWith('/') ? `https://remanga.org${path}` : `https://remanga.org/${path}`;
    }
  }

  class DomFallbackClient {
    async fetchComments(article) {
      if (!(article instanceof Element)) {
        return [];
      }

      const users = new Map();
      const commentsRoot = this.findCommentsRoot(article);
      const links = Array.from((commentsRoot || article).querySelectorAll(SELECTORS.userLink)).filter((link) => this.isCommentUserLink(link));

      for (const link of links) {
        const user = this.normalizeUserLink(link);
        if (user) {
          users.set(user.id, user);
        }
      }

      const postAuthor = this.getPostAuthor(article);
      if (postAuthor) {
        users.delete(postAuthor.id);
      }

      return Array.from(users.values());
    }

    isCommentUserLink(link) {
      if (!(link instanceof HTMLAnchorElement)) {
        return false;
      }

      let current = link;
      for (let depth = 0; depth < 6 && current instanceof Element; depth += 1) {
        const text = this.elementText(current);
        if (text.includes('ответить') || text.includes('посмотреть') || text.includes('час назад') || text.includes('минут') || text.includes('день назад')) {
          return true;
        }

        const buttons = Array.from(current.querySelectorAll('button'));
        if (buttons.some((button) => this.elementText(button).includes('ответить'))) {
          return true;
        }

        current = current.parentElement;
      }

      return false;
    }

    async fetchLikes(article) {
      const reactionButton = this.findReactionButton(article) || this.findReactionButton(document.body);
      if (!reactionButton) {
        return [];
      }

      const wasOpen = Boolean(document.querySelector(SELECTORS.dialog));
      if (!wasOpen) {
        reactionButton.click();
      }

      const dialog = await this.waitFor(() => document.querySelector(SELECTORS.dialog), 3000);
      if (!dialog) {
        return [];
      }

      const tab = Array.from(dialog.querySelectorAll('button')).find((button) => button.textContent?.trim() === 'Лайки');
      if (tab) {
        tab.click();
      }

      await this.waitFor(() => dialog.querySelectorAll(SELECTORS.userLink).length > 0, 3000);
      await this.collectAllLikes(dialog);

      const users = new Map();
      const links = Array.from(dialog.querySelectorAll(SELECTORS.userLink));
      for (const link of links) {
        const user = this.normalizeUserLink(link);
        if (user) {
          users.set(user.id, user);
        }
      }

      if (!wasOpen) {
        const closeButton = Array.from(dialog.querySelectorAll('button')).find((button) => !button.textContent?.trim());
        if (closeButton) {
          closeButton.click();
        } else {
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        }
      }

      return Array.from(users.values());
    }

    findCommentsRoot(article) {
      const candidates = [
        article.nextElementSibling,
        article.parentElement,
        document.querySelector(SELECTORS.main),
        document.body,
      ].filter((node) => node instanceof Element);

      for (const candidate of candidates) {
        const buttons = Array.from(candidate.querySelectorAll('button'));
        const hasReplyButtons = buttons.some((button) => this.elementText(button).includes('ответить'));
        const hasShowMore = buttons.some((button) => this.elementText(button).includes('показать еще'));
        if (hasReplyButtons || hasShowMore) {
          return candidate;
        }
      }

      return article;
    }

    async collectAllLikes(dialog) {
      let previousCount = -1;

      for (let step = 0; step < 30; step += 1) {
        const linksCount = dialog.querySelectorAll(SELECTORS.userLink).length;
        if (linksCount === previousCount) {
          break;
        }
        previousCount = linksCount;

        const loadMoreButton = Array.from(dialog.querySelectorAll('button')).find((button) => {
          const text = this.elementText(button);
          return text.includes('показать') || text.includes('ещ') || text.includes('more');
        });

        if (!loadMoreButton) {
          break;
        }

        loadMoreButton.click();
        await this.waitFor(() => dialog.querySelectorAll(SELECTORS.userLink).length > previousCount, 2000);
      }
    }

    findReactionButton(article) {
      if (!(article instanceof Element)) {
        return null;
      }

      return Array.from(article.querySelectorAll('button')).find((button) => this.elementText(button).includes('реакц')) || null;
    }

    elementText(element) {
      return [element.textContent, element.getAttribute?.('aria-label'), element.getAttribute?.('title')]
        .filter(Boolean)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
    }

    getPostAuthor(article) {
      const firstUserLink = article.querySelector(SELECTORS.userLink);
      return firstUserLink ? this.normalizeUserLink(firstUserLink) : null;
    }

    normalizeUserLink(link) {
      if (!(link instanceof HTMLAnchorElement)) {
        return null;
      }

      const href = link.getAttribute('href') || '';
      const match = href.match(/\/user\/(\d+)\/about/);
      if (!match) {
        return null;
      }

      const usernameElement = link.querySelector('img[alt]');
      const username = (link.textContent || usernameElement?.getAttribute('alt') || '').trim();
      if (!username) {
        return null;
      }

      const avatar = link.querySelector('img');
      return {
        id: Number(match[1]),
        username,
        profileUrl: new URL(href, window.location.origin).toString(),
        avatarUrl: avatar?.getAttribute('src') || null,
      };
    }

    waitFor(predicate, timeoutMs) {
      return new Promise((resolve) => {
        const start = Date.now();
        const tick = () => {
          const value = predicate();
          if (value) {
            resolve(value);
            return;
          }

          if (Date.now() - start >= timeoutMs) {
            resolve(null);
            return;
          }

          window.setTimeout(tick, 80);
        };

        tick();
      });
    }
  }

  class SubscriptionFilterService {
    constructor(apiClient) {
      this.apiClient = apiClient;
    }

    async filterData(data, profileIds) {
      const ids = this.normalizeProfileIds(profileIds);
      if (ids.length === 0) {
        return data;
      }

      const followerSets = await Promise.all(ids.map((id) => this.loadFollowerIds(id)));
      return {
        comments: this.filterUsers(data.comments, followerSets),
        likes: this.filterUsers(data.likes, followerSets),
        intersection: this.filterUsers(data.intersection, followerSets),
      };
    }

    normalizeProfileIds(profileIds) {
      if (!Array.isArray(profileIds)) {
        return [];
      }

      const seen = new Set();
      const ids = [];
      for (const value of profileIds) {
        const id = Number(value);
        if (!Number.isSafeInteger(id) || id <= 0 || seen.has(id)) {
          continue;
        }

        seen.add(id);
        ids.push(id);
      }

      return ids;
    }

    async loadFollowerIds(profileId) {
      const users = await this.apiClient.fetchFollowers(profileId);
      return new Set(users.map((user) => user.id));
    }

    filterUsers(users, followerSets) {
      return users.filter((user) => followerSets.every((followers) => followers.has(user.id)));
    }
  }

  class UserActivityService {
    constructor(apiClient, domFallbackClient, subscriptionFilterService) {
      this.apiClient = apiClient;
      this.domFallbackClient = domFallbackClient;
      this.subscriptionFilterService = subscriptionFilterService;
    }

    async load(article, slug, postId, subscriptionProfileIds = []) {
      const [commentUsers, likeUsers] = await Promise.all([
        this.loadComments(article, postId),
        this.loadLikes(article, slug),
      ]);

      const commentMap = new Map(commentUsers.map((user) => [user.id, user]));
      const likeMap = new Map(likeUsers.map((user) => [user.id, user]));
      const intersection = [];

      for (const [id, user] of commentMap.entries()) {
        if (likeMap.has(id)) {
          intersection.push(user);
        }
      }

      const data = {
        comments: this.sortUsers(commentUsers),
        likes: this.sortUsers(likeUsers),
        intersection: this.sortUsers(intersection),
      };

      if (!this.subscriptionFilterService) {
        return data;
      }

      const filteredData = await this.subscriptionFilterService.filterData(data, subscriptionProfileIds);
      return {
        comments: this.sortUsers(filteredData.comments),
        likes: this.sortUsers(filteredData.likes),
        intersection: this.sortUsers(filteredData.intersection),
      };
    }

    async loadComments(article, postId) {
      if (postId) {
        try {
          return await this.apiClient.fetchComments(postId);
        } catch (_error) {
        }
      }

      return this.domFallbackClient.fetchComments(article);
    }

    async loadLikes(article, slug) {
      if (slug) {
        try {
          return await this.apiClient.fetchLikes(slug);
        } catch (_error) {
        }
      }

      return this.domFallbackClient.fetchLikes(article);
    }

    sortUsers(users) {
      return [...users].sort((left, right) => left.username.localeCompare(right.username, 'ru'));
    }
  }

  class ActivityPanel {
    constructor(settingsStore) {
      this.settingsStore = settingsStore;
      this.root = null;
      this.panel = null;
      this.overlay = null;
      this.closeButton = null;
      this.copyAllButton = null;
      this.applyFilterButton = null;
      this.subscriptionInput = null;
      this.filterStatus = null;
      this.tabButtons = new Map();
      this.countElements = new Map();
      this.list = null;
      this.status = null;
      this.title = null;
      this.data = null;
      this.isOpen = false;
      this.statusResetTimer = null;
      this.handleDocumentClick = this.handleDocumentClick.bind(this);
      this.handleEscape = this.handleEscape.bind(this);
    }

    mount(anchor, onRefresh, options = {}) {
      this.unmount();
      this.ensureStyles();

      const mountTarget = anchor instanceof Element ? anchor : document.body;
      const isFloating = options.floating === true || mountTarget === document.body;

      this.root = document.createElement('div');
      this.root.className = isFloating ? `${ROOT_CLASS} rmfa-root--floating` : ROOT_CLASS;

      const trigger = document.createElement('button');
      trigger.type = 'button';
      trigger.className = BUTTON_CLASS;
      trigger.textContent = 'Активность';
      trigger.addEventListener('click', () => this.toggle());

      this.overlay = document.createElement('div');
      this.overlay.className = 'rmfa-overlay';
      this.overlay.addEventListener('click', () => this.close());

      this.panel = document.createElement('section');
      this.panel.className = PANEL_CLASS;

      const header = document.createElement('div');
      header.className = 'rmfa-header';

      this.title = document.createElement('div');
      this.title.className = 'rmfa-title';
      this.title.textContent = 'Активность поста';

      this.closeButton = document.createElement('button');
      this.closeButton.type = 'button';
      this.closeButton.className = 'rmfa-close';
      this.closeButton.textContent = '×';
      this.closeButton.addEventListener('click', () => this.close());

      header.append(this.title, this.closeButton);

      const tabs = document.createElement('div');
      tabs.className = 'rmfa-tabs';

      for (const [mode, label] of [
        [MODES.comments, 'Комментаторы'],
        [MODES.likes, 'Лайкнувшие'],
        [MODES.intersection, 'Лайк + коммент'],
      ]) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'rmfa-tab';
        button.dataset.mode = mode;
        button.addEventListener('click', () => this.setMode(mode));

        const text = document.createElement('span');
        text.textContent = label;
        const count = document.createElement('span');
        count.className = 'rmfa-count';
        count.textContent = '0';

        button.append(text, count);
        tabs.append(button);
        this.tabButtons.set(mode, button);
        this.countElements.set(mode, count);
      }

      const toolbar = document.createElement('div');
      toolbar.className = 'rmfa-toolbar';

      const refreshButton = document.createElement('button');
      refreshButton.type = 'button';
      refreshButton.className = 'rmfa-refresh';
      refreshButton.textContent = 'Обновить';
      refreshButton.addEventListener('click', () => {
        this.saveSubscriptionProfilesInput();
        onRefresh();
      });

      this.copyAllButton = document.createElement('button');
      this.copyAllButton.type = 'button';
      this.copyAllButton.className = 'rmfa-copy-all';
      this.copyAllButton.textContent = 'Скопировать все';
      this.copyAllButton.addEventListener('click', () => this.copyAllCurrentModeUsers());

      const filter = document.createElement('div');
      filter.className = 'rmfa-filter';

      const filterLabel = document.createElement('label');
      filterLabel.className = 'rmfa-filter-label';
      filterLabel.textContent = 'Профили для фильтра';
      filterLabel.setAttribute('for', 'rmfa-subscription-profiles');

      this.subscriptionInput = document.createElement('textarea');
      this.subscriptionInput.id = 'rmfa-subscription-profiles';
      this.subscriptionInput.className = 'rmfa-filter-input';
      this.subscriptionInput.rows = 3;
      this.subscriptionInput.spellcheck = false;
      this.subscriptionInput.placeholder = 'https://remanga.org/user/2676440/about';
      this.subscriptionInput.value = this.settingsStore.getSubscriptionProfilesInput();

      const filterActions = document.createElement('div');
      filterActions.className = 'rmfa-filter-actions';

      this.filterStatus = document.createElement('div');
      this.filterStatus.className = 'rmfa-filter-status';

      this.applyFilterButton = document.createElement('button');
      this.applyFilterButton.type = 'button';
      this.applyFilterButton.className = 'rmfa-apply-filter';
      this.applyFilterButton.textContent = 'Применить';
      this.applyFilterButton.addEventListener('click', () => {
        this.saveSubscriptionProfilesInput();
        onRefresh();
      });

      filterActions.append(this.filterStatus, this.applyFilterButton);
      filter.append(filterLabel, this.subscriptionInput, filterActions);

      const toolbarActions = document.createElement('div');
      toolbarActions.className = 'rmfa-toolbar-actions';
      toolbarActions.append(this.copyAllButton, refreshButton);

      this.status = document.createElement('div');
      this.status.className = 'rmfa-status';
      this.status.textContent = 'Загрузка...';

      toolbar.append(this.status, toolbarActions);

      this.list = document.createElement('div');
      this.list.className = 'rmfa-list';

      this.panel.append(header, tabs, filter, toolbar, this.list);
      this.root.append(trigger, this.overlay, this.panel);
      this.root.dataset.open = 'false';
      this.overlay.hidden = true;
      this.panel.hidden = true;
      mountTarget.append(this.root);

      this.setMode(this.settingsStore.getMode());
      this.updateFilterStatus();
      document.addEventListener('click', this.handleDocumentClick);
      document.addEventListener('keydown', this.handleEscape);
    }

    unmount() {
      document.removeEventListener('click', this.handleDocumentClick);
      document.removeEventListener('keydown', this.handleEscape);

      if (this.root) {
        this.root.remove();
      }

      this.root = null;
      this.panel = null;
      this.overlay = null;
      this.closeButton = null;
      this.copyAllButton = null;
      this.applyFilterButton = null;
      this.subscriptionInput = null;
      this.filterStatus = null;
      this.list = null;
      this.status = null;
      this.title = null;
      this.data = null;
      this.isOpen = false;
      window.clearTimeout(this.statusResetTimer);
      this.statusResetTimer = null;
      this.tabButtons.clear();
      this.countElements.clear();
    }

    setLoading() {
      this.data = null;
      window.clearTimeout(this.statusResetTimer);
      this.statusResetTimer = null;
      if (this.status) {
        this.status.textContent = 'Загрузка...';
      }
      if (this.list) {
        this.list.innerHTML = '';
      }
      if (this.copyAllButton) {
        this.copyAllButton.disabled = true;
      }
      if (this.applyFilterButton) {
        this.applyFilterButton.disabled = true;
      }
      for (const count of this.countElements.values()) {
        count.textContent = '0';
      }
    }

    setError(message) {
      window.clearTimeout(this.statusResetTimer);
      this.statusResetTimer = null;
      if (this.copyAllButton) {
        this.copyAllButton.disabled = true;
      }
      if (this.applyFilterButton) {
        this.applyFilterButton.disabled = false;
      }
      if (this.status) {
        this.status.textContent = message;
      }
      if (this.list) {
        this.list.innerHTML = '<div class="rmfa-empty">Не удалось получить данные.</div>';
      }
    }

    setData(data) {
      this.data = data;
      if (this.copyAllButton) {
        this.copyAllButton.disabled = false;
      }
      if (this.applyFilterButton) {
        this.applyFilterButton.disabled = false;
      }
      this.updateFilterStatus();
      this.countElements.get(MODES.comments).textContent = String(data.comments.length);
      this.countElements.get(MODES.likes).textContent = String(data.likes.length);
      this.countElements.get(MODES.intersection).textContent = String(data.intersection.length);
      this.renderCurrentMode();
    }

    setMode(mode) {
      this.settingsStore.setMode(mode);
      for (const [itemMode, button] of this.tabButtons.entries()) {
        button.dataset.active = String(itemMode === mode);
      }
      this.renderCurrentMode();
    }

    saveSubscriptionProfilesInput() {
      const value = this.subscriptionInput ? this.subscriptionInput.value : '';
      this.settingsStore.setSubscriptionProfilesInput(value);
      this.updateFilterStatus();
    }

    updateFilterStatus() {
      if (!this.filterStatus) {
        return;
      }

      const input = this.settingsStore.getSubscriptionProfilesInput();
      const result = this.settingsStore.getSubscriptionProfileParseResult();
      if (!input.trim()) {
        this.filterStatus.textContent = 'Фильтр выключен';
        return;
      }

      if (result.ids.length === 0) {
        this.filterStatus.textContent = 'Нет валидных профилей';
        return;
      }

      const skipped = result.invalidCount > 0 ? `, пропущено: ${result.invalidCount}` : '';
      this.filterStatus.textContent = `Профилей: ${result.ids.length}${skipped}`;
    }

    getCurrentModeUsers() {
      const mode = this.settingsStore.getMode();
      return this.data?.[mode] || [];
    }

    async copyAllCurrentModeUsers() {
      const users = this.getCurrentModeUsers();
      if (users.length === 0) {
        this.showTemporaryStatus('Список пуст.');
        return;
      }

      await this.copyText(users.map((user) => user.username).join('\n'), `Скопировано: ${users.length}`);
    }

    async copyUser(username) {
      await this.copyText(username, `Скопировано: ${username}`);
    }

    async copyText(value, successMessage) {
      try {
        await navigator.clipboard.writeText(value);
        this.showTemporaryStatus(successMessage);
      } catch (error) {
        console.warn('[RMFA] Ошибка копирования', error);
        this.showTemporaryStatus('Не удалось скопировать.');
      }
    }

    showTemporaryStatus(message) {
      window.clearTimeout(this.statusResetTimer);
      this.statusResetTimer = null;

      if (!this.status) {
        return;
      }

      this.status.textContent = message;
      if (!this.data) {
        return;
      }

      this.statusResetTimer = window.setTimeout(() => {
        if (!this.status) {
          return;
        }

        this.status.textContent = `Пользователей: ${this.getCurrentModeUsers().length}`;
        this.statusResetTimer = null;
      }, 2000);
    }

    renderCurrentMode() {
      const mode = this.settingsStore.getMode();
      if (!this.data || !this.list || !this.status) {
        return;
      }

      const users = this.data[mode] || [];
      this.status.textContent = `Пользователей: ${users.length}`;
      this.list.innerHTML = '';
      if (this.copyAllButton) {
        this.copyAllButton.disabled = users.length === 0;
      }

      if (users.length === 0) {
        this.list.innerHTML = '<div class="rmfa-empty">Список пуст.</div>';
        return;
      }

      const fragment = document.createDocumentFragment();
      for (const user of users) {
        const item = document.createElement('div');
        item.className = 'rmfa-user';

        const link = document.createElement('a');
        link.className = 'rmfa-user-link';
        link.href = user.profileUrl;
        link.target = '_blank';
        link.rel = 'noreferrer noopener';

        const avatar = document.createElement('div');
        avatar.className = 'rmfa-avatar';
        if (user.avatarUrl) {
          const image = document.createElement('img');
          image.src = user.avatarUrl;
          image.alt = user.username;
          image.loading = 'lazy';
          avatar.append(image);
        } else {
          avatar.textContent = user.username.slice(0, 1).toUpperCase();
        }

        const name = document.createElement('span');
        name.className = 'rmfa-username';
        name.textContent = user.username;

        link.append(avatar, name);

        const copyButton = document.createElement('button');
        copyButton.type = 'button';
        copyButton.className = 'rmfa-copy-user';
        copyButton.textContent = 'Копировать';
        copyButton.addEventListener('click', () => this.copyUser(user.username));

        item.append(link, copyButton);
        fragment.append(item);
      }

      this.list.append(fragment);
    }

    toggle() {
      if (this.isOpen) {
        this.close();
      } else {
        this.open();
      }
    }

    open() {
      if (!this.root || !this.panel || !this.overlay) {
        return;
      }

      this.isOpen = true;
      this.root.dataset.open = 'true';
      this.panel.dataset.mobile = String(window.innerWidth < MOBILE_BREAKPOINT);
      this.overlay.hidden = false;
      this.panel.hidden = false;
    }

    close() {
      if (!this.root || !this.panel || !this.overlay) {
        return;
      }

      this.isOpen = false;
      this.root.dataset.open = 'false';
      this.overlay.hidden = true;
      this.panel.hidden = true;
    }

    handleDocumentClick(event) {
      if (!this.isOpen || !this.root) {
        return;
      }

      const target = event.target;
      if (!(target instanceof Node) || this.root.contains(target)) {
        return;
      }

      this.close();
    }

    handleEscape(event) {
      if (event.key === 'Escape' && this.isOpen) {
        this.close();
      }
    }

    ensureStyles() {
      if (document.getElementById(STYLE_ID)) {
        return;
      }

      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = `
        .${ROOT_CLASS} {
          position: relative;
          display: inline-flex;
          margin-left: 8px;
        }

        .rmfa-root--floating {
          --rmfa-floating-bottom: max(18px, env(safe-area-inset-bottom));
          position: fixed;
          right: max(18px, env(safe-area-inset-right));
          bottom: var(--rmfa-floating-bottom);
          z-index: 2147483645;
          margin-left: 0;
        }

        .${BUTTON_CLASS} {
          border: 1px solid rgba(255, 255, 255, 0.12);
          background: rgba(255, 255, 255, 0.08);
          color: inherit;
          border-radius: 999px;
          padding: 6px 12px;
          font: inherit;
          cursor: pointer;
          transition: background 0.2s ease, border-color 0.2s ease, transform 0.2s ease;
        }

        .rmfa-root--floating .${BUTTON_CLASS} {
          background: #4f7cff;
          color: #fff;
          border-color: rgba(255, 255, 255, 0.24);
          box-shadow: 0 12px 30px rgba(0, 0, 0, 0.42);
          font-weight: 700;
        }

        .${BUTTON_CLASS}:hover {
          background: rgba(255, 255, 255, 0.14);
          border-color: rgba(255, 255, 255, 0.2);
        }

        .rmfa-overlay {
          position: fixed;
          inset: 0;
          background: rgba(0, 0, 0, 0.42);
          z-index: 2147483646;
        }

        .${PANEL_CLASS} {
          position: absolute;
          top: calc(100% + 8px);
          right: 0;
          width: min(420px, calc(100vw - 24px));
          max-height: min(70vh, 720px);
          display: flex;
          flex-direction: column;
          gap: 12px;
          padding: 14px;
          border-radius: 16px;
          background: #111318;
          color: #f4f6fb;
          border: 1px solid rgba(255, 255, 255, 0.12);
          box-shadow: 0 20px 40px rgba(0, 0, 0, 0.45);
          z-index: 2147483647;
        }

        .rmfa-root--floating .${PANEL_CLASS} {
          position: fixed;
          top: auto;
          right: max(18px, env(safe-area-inset-right));
          bottom: calc(var(--rmfa-floating-bottom) + 54px);
        }

        .${PANEL_CLASS}[hidden],
        .rmfa-overlay[hidden] {
          display: none;
        }

        .rmfa-header,
        .rmfa-toolbar {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
        }

        .rmfa-toolbar-actions {
          display: flex;
          align-items: center;
          gap: 8px;
          flex-wrap: wrap;
          justify-content: flex-end;
        }

        .rmfa-filter {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }

        .rmfa-filter-label {
          color: rgba(244, 246, 251, 0.86);
          font-size: 13px;
          font-weight: 700;
        }

        .rmfa-filter-input {
          width: 100%;
          min-height: 76px;
          max-height: 140px;
          resize: vertical;
          box-sizing: border-box;
          border: 1px solid rgba(255, 255, 255, 0.12);
          border-radius: 10px;
          background: rgba(255, 255, 255, 0.06);
          color: inherit;
          padding: 10px 12px;
          font: inherit;
          font-size: 13px;
          line-height: 1.4;
        }

        .rmfa-filter-input::placeholder {
          color: rgba(244, 246, 251, 0.42);
        }

        .rmfa-filter-actions {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
        }

        .rmfa-filter-status {
          min-width: 0;
          color: rgba(244, 246, 251, 0.72);
          font-size: 12px;
        }

        .rmfa-title {
          font-size: 16px;
          font-weight: 700;
        }

        .rmfa-close,
        .rmfa-refresh,
        .rmfa-apply-filter,
        .rmfa-copy-all,
        .rmfa-copy-user,
        .rmfa-tab {
          border: 0;
          background: rgba(255, 255, 255, 0.08);
          color: inherit;
          cursor: pointer;
          font: inherit;
        }

        .rmfa-close {
          width: 32px;
          height: 32px;
          border-radius: 999px;
          font-size: 22px;
          line-height: 1;
        }

        .rmfa-tabs {
          display: grid;
          grid-template-columns: repeat(3, minmax(0, 1fr));
          gap: 8px;
        }

        .rmfa-tab {
          display: flex;
          flex-direction: column;
          align-items: flex-start;
          gap: 4px;
          padding: 10px;
          border-radius: 12px;
          text-align: left;
        }

        .rmfa-tab[data-active="true"] {
          background: #4f7cff;
        }

        .rmfa-count {
          font-size: 12px;
          opacity: 0.92;
        }

        .rmfa-refresh,
        .rmfa-apply-filter,
        .rmfa-copy-all,
        .rmfa-copy-user {
          border-radius: 10px;
          padding: 8px 12px;
        }

        .rmfa-copy-all:disabled,
        .rmfa-apply-filter:disabled {
          opacity: 0.5;
          cursor: default;
        }

        .rmfa-copy-user {
          flex-shrink: 0;
        }

        .rmfa-copy-user:hover,
        .rmfa-copy-all:hover,
        .rmfa-refresh:hover,
        .rmfa-apply-filter:hover,
        .rmfa-close:hover {
          background: rgba(255, 255, 255, 0.14);
        }

        .rmfa-copy-user:focus-visible,
        .rmfa-copy-all:focus-visible,
        .rmfa-refresh:focus-visible,
        .rmfa-apply-filter:focus-visible,
        .rmfa-filter-input:focus-visible,
        .rmfa-close:focus-visible,
        .rmfa-tab:focus-visible,
        .${BUTTON_CLASS}:focus-visible {
          outline: 2px solid #7ea0ff;
          outline-offset: 2px;
        }

        .rmfa-user-link {
          min-width: 0;
          flex: 1;
          display: flex;
          align-items: center;
          gap: 10px;
          text-decoration: none;
          color: inherit;
        }

        .rmfa-status {
          color: rgba(244, 246, 251, 0.8);
          font-size: 13px;
        }

        .rmfa-list {
          display: flex;
          flex-direction: column;
          gap: 8px;
          overflow: auto;
          min-height: 120px;
          padding-right: 4px;
        }

        .rmfa-user {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 10px 12px;
          border-radius: 12px;
          background: rgba(255, 255, 255, 0.05);
        }

        .rmfa-user:hover {
          background: rgba(255, 255, 255, 0.1);
        }

        .rmfa-user-link:hover .rmfa-username {
          text-decoration: underline;
        }

        .rmfa-user-link:focus-visible {
          outline: none;
        }

        .rmfa-user-link:focus-visible .rmfa-username {
          text-decoration: underline;
        }

        .rmfa-avatar {
          width: 36px;
          height: 36px;
          min-width: 36px;
          border-radius: 999px;
          overflow: hidden;
          display: grid;
          place-items: center;
          background: rgba(255, 255, 255, 0.1);
          font-size: 14px;
          font-weight: 700;
        }

        .rmfa-avatar img {
          width: 100%;
          height: 100%;
          object-fit: cover;
        }

        .rmfa-username {
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .rmfa-empty {
          padding: 16px;
          border-radius: 12px;
          background: rgba(255, 255, 255, 0.05);
          color: rgba(244, 246, 251, 0.8);
        }

        @media (max-width: 767px) {
          .rmfa-root--floating {
            --rmfa-floating-bottom: calc(max(18px, env(safe-area-inset-bottom)) + 64px);
          }

          .${PANEL_CLASS}[data-mobile="true"],
          .rmfa-root--floating .${PANEL_CLASS}[data-mobile="true"] {
            position: fixed;
            left: 0;
            right: 0;
            top: auto;
            bottom: 0;
            width: 100vw;
            max-width: 100vw;
            max-height: 82vh;
            border-bottom-left-radius: 0;
            border-bottom-right-radius: 0;
            padding-bottom: max(14px, env(safe-area-inset-bottom));
          }

          .rmfa-tabs {
            grid-template-columns: 1fr;
          }

          .rmfa-toolbar {
            align-items: flex-start;
            flex-direction: column;
          }

          .rmfa-toolbar-actions {
            width: 100%;
            justify-content: stretch;
          }

          .rmfa-filter-actions {
            align-items: stretch;
            flex-direction: column;
          }

          .rmfa-copy-all,
          .rmfa-refresh,
          .rmfa-apply-filter,
          .rmfa-copy-user {
            flex: 1;
          }

          .rmfa-user {
            align-items: flex-start;
            flex-direction: column;
          }

          .rmfa-user-link {
            width: 100%;
          }

          .${ROOT_CLASS} {
            margin-left: 6px;
          }

          .${BUTTON_CLASS} {
            padding: 6px 10px;
            font-size: 13px;
          }
        }
      `;

      document.head.append(style);
    }
  }

  class RemangaForumActivityApp {
    constructor() {
      this.detector = new ForumPageDetector();
      this.settingsStore = new SettingsStore();
      this.apiClient = new ApiClient();
      this.domFallbackClient = new DomFallbackClient();
      this.subscriptionFilterService = new SubscriptionFilterService(this.apiClient);
      this.activityService = new UserActivityService(this.apiClient, this.domFallbackClient, this.subscriptionFilterService);
      this.panel = new ActivityPanel(this.settingsStore);
      this.lastUrl = '';
      this.isRefreshing = false;
      this.observer = null;
      this.bootstrap = this.bootstrap.bind(this);
    }

    start() {
      this.bootstrap();
      this.observeDom();
      this.observeNavigation();
    }

    async bootstrap() {
      const currentUrl = window.location.href;
      if (currentUrl === this.lastUrl && document.querySelector(`.${BUTTON_CLASS}`)) {
        return;
      }

      this.lastUrl = currentUrl;
      this.panel.unmount();

      if (!this.detector.isForumPostPage()) {
        return;
      }

      this.panel.mount(document.body, () => this.refresh(), { floating: true });
      await this.refresh();
    }

    async refresh(article = this.findPostArticle()) {
      if (this.isRefreshing) {
        return;
      }

      this.isRefreshing = true;
      this.panel.setLoading();

      try {
        const slug = this.detector.getSlug();
        const postId = this.detector.getPostId();
        const profileIds = this.settingsStore.getSubscriptionProfileParseResult().ids;
        const data = await this.activityService.load(article, slug, postId, profileIds);
        this.panel.setData(data);
      } catch (error) {
        console.warn('[RMFA] Ошибка загрузки активности', error);
        this.panel.setError('Ошибка загрузки');
      } finally {
        this.isRefreshing = false;
      }
    }

    findPostArticle() {
      const root = document.querySelector(SELECTORS.main) || document.body;
      const articles = Array.from(root.querySelectorAll(SELECTORS.article));
      if (articles.length === 0) {
        return null;
      }

      const withActions = articles.find((article) => {
        const buttons = Array.from(article.querySelectorAll('button'));
        const hasReactionButton = buttons.some((button) => this.isReactionButton(button));
        const hasCommentButton = buttons.some((button) => this.isCommentButton(button));
        return hasReactionButton || hasCommentButton;
      });
      if (withActions) {
        return withActions;
      }

      const withUserLinks = articles
        .filter((article) => article.querySelector(SELECTORS.userLink))
        .sort((left, right) => (right.innerText || '').length - (left.innerText || '').length);

      return withUserLinks[0] || articles[0] || null;
    }

    findActionAnchor(article) {
      if (!(article instanceof Element)) {
        return null;
      }

      const buttons = Array.from(article.querySelectorAll('button'));
      const reactionButton = buttons.find((button) => this.isReactionButton(button));
      const commentButton = buttons.find((button) => this.isCommentButton(button));

      if (reactionButton && commentButton) {
        return this.findLowestCommonAncestor(reactionButton, commentButton) || reactionButton.parentElement;
      }

      return reactionButton?.parentElement || commentButton?.parentElement || article;
    }

    isReactionButton(button) {
      return this.elementText(button).includes('реакц');
    }

    isCommentButton(button) {
      return this.elementText(button).includes('комментар');
    }

    elementText(element) {
      return [element.textContent, element.getAttribute?.('aria-label'), element.getAttribute?.('title')]
        .filter(Boolean)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
    }

    findLowestCommonAncestor(first, second) {
      const visited = new Set();
      let current = first;
      while (current) {
        visited.add(current);
        current = current.parentElement;
      }

      current = second;
      while (current) {
        if (visited.has(current)) {
          return current;
        }
        current = current.parentElement;
      }

      return null;
    }

    observeDom() {
      this.observer = new MutationObserver(() => {
        window.requestAnimationFrame(this.bootstrap);
      });

      this.observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
      });
    }

    observeNavigation() {
      const wrap = (methodName) => {
        const original = history[methodName];
        history[methodName] = (...args) => {
          const result = original.apply(history, args);
          window.setTimeout(this.bootstrap, 50);
          return result;
        };
      };

      wrap('pushState');
      wrap('replaceState');
      window.addEventListener('popstate', () => window.setTimeout(this.bootstrap, 50));
    }
  }

  new RemangaForumActivityApp().start();
})();
