/**
 * App Controller
 * Manual x-position layout + tap-to-compare interaction.
 */

(async function () {
  const treeContainer = document.getElementById("tree-container");
  const svgLayer = document.getElementById("svg-lines");
  const resultEl = document.getElementById("result");
  const resultTextEl = document.getElementById("result-text");
  const clearBtn = document.getElementById("clear-btn");
  const statusTextEl = document.getElementById("status-text");

  let relationshipGraph = null;
  let selectedA = null;
  let familyData = null;

  const CARD_W = 110;
  const CARD_H = 62;
  const COUPLE_GAP = 10;
  const SIBLING_GAP = 16;
  const RANK_SEP = 110;

  // Load family data
  try {
    const response = await fetch("data/family.jsonc");
    const text = await response.text();
    const cleaned = text.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    familyData = JSON.parse(cleaned);
    relationshipGraph = new FamilyGraph(familyData);
    renderTree();
  } catch (err) {
    treeContainer.innerHTML = `<p class="error">Failed to load family data. Please try refreshing.</p>`;
    console.error("Error loading family data:", err);
    return;
  }

  // ==========================================================================
  // LAYOUT
  // ==========================================================================

  function renderTree() {
    const people = familyData.people;
    const marriages = familyData.marriages || [];
    const genMap = assignGenerations(people, marriages);
    const nodePositions = computePositions(people, marriages, genMap);
    renderCards(nodePositions);
    drawConnections(nodePositions, marriages, people);
  }

  function assignGenerations(people, marriages) {
    const genMap = new Map();
    const childrenMap = new Map();
    for (const p of people) childrenMap.set(p.id, []);
    for (const p of people) for (const pid of p.parents) {
      if (childrenMap.has(pid)) childrenMap.get(pid).push(p.id);
    }

    const depthCache = new Map();
    function getDepth(personId, visited) {
      if (depthCache.has(personId)) return depthCache.get(personId);
      if (visited.has(personId)) return 0;
      visited.add(personId);
      let allChildren = [...(childrenMap.get(personId) || [])];
      for (const m of marriages) {
        if (m.partners.includes(personId)) {
          const sp = m.partners.find(id => id !== personId);
          for (const sc of (childrenMap.get(sp) || [])) {
            if (!allChildren.includes(sc)) allChildren.push(sc);
          }
        }
      }
      if (allChildren.length === 0) { depthCache.set(personId, 0); return 0; }
      const mx = Math.max(...allChildren.map(c => getDepth(c, new Set([...visited]))));
      depthCache.set(personId, mx + 1);
      return mx + 1;
    }
    for (const p of people) getDepth(p.id, new Set());
    const maxD = Math.max(...people.map(p => depthCache.get(p.id) || 0));
    for (const p of people) genMap.set(p.id, maxD - (depthCache.get(p.id) || 0));

    // Enforce constraints
    let changed = true;
    while (changed) {
      changed = false;
      for (const p of people) {
        if (p.parents.length === 0) continue;
        let mx = -1;
        for (const pid of p.parents) mx = Math.max(mx, genMap.get(pid));
        if (genMap.get(p.id) < mx + 1) { genMap.set(p.id, mx + 1); changed = true; }
      }
      for (const m of marriages) {
        const [p1, p2] = m.partners;
        const g1 = genMap.get(p1), g2 = genMap.get(p2);
        if (g1 !== g2) { genMap.set(p1, Math.max(g1, g2)); genMap.set(p2, Math.max(g1, g2)); changed = true; }
      }
    }

    // Pull up
    changed = true;
    while (changed) {
      changed = false;
      for (const p of people) {
        if (p.parents.length === 0) continue;
        let mx = -1;
        for (const pid of p.parents) mx = Math.max(mx, genMap.get(pid));
        if (genMap.get(p.id) > mx + 1) { genMap.set(p.id, mx + 1); changed = true; }
      }
      for (const m of marriages) {
        const [p1, p2] = m.partners;
        const g1 = genMap.get(p1), g2 = genMap.get(p2);
        if (g1 !== g2) {
          const mn = Math.min(g1, g2);
          let ok = true;
          for (const id of [p1, p2]) {
            const pr = people.find(x => x.id === id);
            if (pr) for (const pid of pr.parents) if (genMap.get(pid) >= mn) ok = false;
          }
          if (ok) { genMap.set(p1, mn); genMap.set(p2, mn); changed = true; }
        }
      }
    }
    return genMap;
  }

  /**
   * Position people by mapping their x field directly to pixel positions.
   * Same x value = same horizontal position across all generations.
   * x range is -5 to 5, mapped to the available width.
   */
  function computePositions(people, marriages, genMap) {
    const positions = new Map();
    const byGen = new Map();
    for (const person of people) {
      const g = genMap.get(person.id);
      if (!byGen.has(g)) byGen.set(g, []);
      byGen.get(g).push(person);
    }

    // Find the x range used in data
    const allX = people.map(p => p.x || 0);
    const minDataX = Math.min(...allX);
    const maxDataX = Math.max(...allX);
    const dataRange = maxDataX - minDataX || 1;

    // Map data x to pixel x. Use CARD_W spacing as the base unit.
    // Each 1.0 unit of x = one card width + gap
    const UNIT_PX = CARD_W + SIBLING_GAP;
    const offsetX = 20; // left margin

    function dataXToPixelX(dataX) {
      return offsetX + (dataX - minDataX) * UNIT_PX;
    }

    const sortedGens = [...byGen.keys()].sort((a, b) => a - b);
    for (let i = 0; i < sortedGens.length; i++) {
      const members = byGen.get(sortedGens[i]);
      const y = 20 + i * RANK_SEP;
      for (const person of members) {
        const px = dataXToPixelX(person.x || 0);
        positions.set(person.id, { x: px, y, w: CARD_W, h: CARD_H });
      }
    }
    return positions;
  }

  // ==========================================================================
  // RENDERING
  // ==========================================================================

  function renderCards(nodePositions) {
    treeContainer.querySelectorAll(".person-card").forEach(el => el.remove());
    for (const person of familyData.people) {
      const pos = nodePositions.get(person.id);
      if (!pos) continue;
      // Skip blank placeholder names
      if (!person.name) continue;
      const card = createPersonCard(person);
      card.style.left = pos.x + "px";
      card.style.top = pos.y + "px";
      treeContainer.appendChild(card);
    }
    let maxX = 0, maxY = 0;
    for (const pos of nodePositions.values()) {
      maxX = Math.max(maxX, pos.x + pos.w);
      maxY = Math.max(maxY, pos.y + pos.h);
    }
    treeContainer.style.width = (maxX + 20) + "px";
    treeContainer.style.height = (maxY + 20) + "px";
    svgLayer.setAttribute("width", maxX + 20);
    svgLayer.setAttribute("height", maxY + 20);
  }

  function drawConnections(nodePositions, marriages, people) {
    svgLayer.innerHTML = "";

    // Marriage connectors
    for (const marriage of marriages) {
      const [p1, p2] = marriage.partners;
      const pos1 = nodePositions.get(p1);
      const pos2 = nodePositions.get(p2);
      if (!pos1 || !pos2) continue;
      const y = pos1.y + CARD_H / 2;
      const x1 = Math.min(pos1.x, pos2.x) + CARD_W;
      const x2 = Math.max(pos1.x, pos2.x);
      if (x2 > x1) drawLine(x1, y, x2, y, "line-marriage");
    }

    // Parent-child connectors (couples)
    for (const marriage of marriages) {
      const [p1Id, p2Id] = marriage.partners;
      const pos1 = nodePositions.get(p1Id);
      const pos2 = nodePositions.get(p2Id);
      if (!pos1 || !pos2) continue;

      const children = people.filter(p =>
        p.parents.includes(p1Id) && p.parents.includes(p2Id)
      );
      if (children.length === 0) continue;

      const marriageY = pos1.y + CARD_H / 2;
      const parentMidX = (pos1.x + pos2.x + CARD_W) / 2;
      const childPositions = children.map(c => nodePositions.get(c.id)).filter(Boolean);
      if (childPositions.length === 0) continue;

      const childTopY = childPositions[0].y;

      if (childPositions.length === 1) {
        const cp = childPositions[0];
        const childMidX = cp.x + CARD_W / 2;
        if (Math.abs(childMidX - parentMidX) < 2) {
          drawLine(parentMidX, marriageY, parentMidX, childTopY, "line-parent");
        } else {
          const midY = marriageY + (childTopY - marriageY) * 0.5;
          drawLine(parentMidX, marriageY, parentMidX, midY, "line-parent");
          drawLine(parentMidX, midY, childMidX, midY, "line-parent");
          drawLine(childMidX, midY, childMidX, childTopY, "line-parent");
        }
      } else {
        const bracketY = marriageY + (childTopY - marriageY) * 0.5;
        drawLine(parentMidX, marriageY, parentMidX, bracketY, "line-parent");
        const childXs = childPositions.map(cp => cp.x + CARD_W / 2).sort((a, b) => a - b);
        const leftX = Math.min(parentMidX, childXs[0]);
        const rightX = Math.max(parentMidX, childXs[childXs.length - 1]);
        drawLine(leftX, bracketY, rightX, bracketY, "line-parent");
        for (const cp of childPositions) {
          drawLine(cp.x + CARD_W / 2, bracketY, cp.x + CARD_W / 2, childTopY, "line-parent");
        }
      }
    }

    // Single-parent connections
    for (const person of people) {
      if (person.parents.length === 1) {
        const parentPos = nodePositions.get(person.parents[0]);
        const childPos = nodePositions.get(person.id);
        if (!parentPos || !childPos) continue;
        const px = parentPos.x + CARD_W / 2;
        const py = parentPos.y + CARD_H;
        const cx = childPos.x + CARD_W / 2;
        const cy = childPos.y;
        if (Math.abs(px - cx) < 2) {
          drawLine(px, py, cx, cy, "line-parent");
        } else {
          const midY = py + (cy - py) * 0.5;
          drawLine(px, py, px, midY, "line-parent");
          drawLine(px, midY, cx, midY, "line-parent");
          drawLine(cx, midY, cx, cy, "line-parent");
        }
      }
    }
  }

  function drawLine(x1, y1, x2, y2, className) {
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("x1", x1);
    line.setAttribute("y1", y1);
    line.setAttribute("x2", x2);
    line.setAttribute("y2", y2);
    if (className) line.setAttribute("class", className);
    svgLayer.appendChild(line);
  }

  // ==========================================================================
  // INTERACTION
  // ==========================================================================

  function createPersonCard(person) {
    const card = document.createElement("div");
    card.className = "person-card";
    card.setAttribute("role", "option");
    card.setAttribute("tabindex", "0");
    card.setAttribute("data-id", person.id);
    card.setAttribute("aria-selected", "false");

    const yearStr = person.born
      ? (person.died ? `${person.born}\u2013${person.died}` : `${person.born}\u2013`)
      : "";

    card.innerHTML = `
      <div class="person-name">${person.name}</div>
      ${yearStr ? `<div class="person-years">${yearStr}</div>` : ""}
    `;

    card.addEventListener("click", () => handleSelect(person.id, card));
    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        handleSelect(person.id, card);
      }
    });

    return card;
  }

  function handleSelect(personId, cardElement) {
    if (selectedA === null) {
      selectedA = personId;
      cardElement.classList.add("selected-a");
      cardElement.setAttribute("aria-selected", "true");
      const person = relationshipGraph.getPerson(personId);
      statusTextEl.innerHTML = `<span style="color: var(--color-selected-a); font-weight: 700;">${person.name}</span> selected \u2014 tap others to see relationships, or `;
      statusTextEl.classList.add("has-selection");
      clearBtn.classList.remove("hidden");
      hideResult();
    } else if (selectedA === personId) {
      clearSelection();
    } else {
      clearSecondSelection();
      cardElement.classList.add("selected-b");
      const personA = relationshipGraph.getPerson(selectedA);
      const personB = relationshipGraph.getPerson(personId);
      const relationship = relationshipGraph.findRelationship(selectedA, personId);
      showResult(personA.name, personB.name, relationship);
    }
  }

  function showResult(nameA, nameB, relationship) {
    if (relationship === "not directly related") {
      resultTextEl.innerHTML = `<span class="name-b">${nameB}</span> and <span class="name-a">${nameA}</span> are not directly related`;
    } else {
      resultTextEl.innerHTML = `<span class="name-b">${nameB}</span> is <span class="name-a">${nameA}</span>'s ${relationship}`;
    }
    resultEl.classList.remove("hidden");
  }

  function hideResult() {
    resultEl.classList.add("hidden");
    resultTextEl.innerHTML = "";
  }

  function clearSelection() {
    selectedA = null;
    clearCardSelection();
    statusTextEl.textContent = "Select a first person";
    statusTextEl.classList.remove("has-selection");
    clearBtn.classList.add("hidden");
    hideResult();
  }

  function clearSecondSelection() {
    const cards = treeContainer.querySelectorAll(".person-card.selected-b");
    for (const card of cards) card.classList.remove("selected-b");
  }

  function clearCardSelection() {
    const cards = treeContainer.querySelectorAll(".person-card");
    for (const card of cards) {
      card.classList.remove("selected-a", "selected-b");
      card.setAttribute("aria-selected", "false");
    }
  }

  clearBtn.addEventListener("click", () => {
    hideResult();
    clearSelection();
  });
})();
