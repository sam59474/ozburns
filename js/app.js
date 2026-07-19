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
  let currentPositions = null; // stored for path highlighting

  const CARD_W = 110;
  const CARD_H = 62;
  const COUPLE_GAP = 10;
  const SIBLING_GAP = 16;
  const RANK_SEP = 110;
  const DEBUG = window.location.search.includes("debug");

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
    currentPositions = nodePositions;
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

    // Map data x to pixel x.
    // Each 1 unit of x = half a card width + half a gap (so 2 units = one full card slot)
    const UNIT_PX = (CARD_W + SIBLING_GAP) / 2;
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
      ${DEBUG ? `<div class="person-years" style="color:#F56600">[${person.x}]</div>` : ""}
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
      clearHighlight();
      cardElement.classList.add("selected-b");
      const personA = relationshipGraph.getPerson(selectedA);
      const personB = relationshipGraph.getPerson(personId);
      const relationship = relationshipGraph.findRelationship(selectedA, personId);
      showResult(personA.name, personB.name, relationship);
      highlightPath(selectedA, personId);
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
    clearHighlight();
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

  function highlightPath(idA, idB) {
    clearHighlight();
    if (!currentPositions) return;
    const path = relationshipGraph.findPath(idA, idB);
    if (path.length < 2) return;

    const marriages = familyData.marriages || [];
    const people = familyData.people;

    // Highlight intermediate cards
    for (let i = 1; i < path.length - 1; i++) {
      const card = treeContainer.querySelector(`[data-id="${path[i]}"]`);
      if (card) card.classList.add("selected-path");
    }

    // For each step in the path, draw a highlight following the connector geometry
    for (let i = 0; i < path.length - 1; i++) {
      const fromId = path[i];
      const toId = path[i + 1];
      const fromPos = currentPositions.get(fromId);
      const toPos = currentPositions.get(toId);
      if (!fromPos || !toPos) continue;

      // Check if this is a marriage link (same generation, married)
      const areMarried = marriages.some(m =>
        m.partners.includes(fromId) && m.partners.includes(toId)
      );

      if (areMarried) {
        // Horizontal marriage line
        const y = fromPos.y + CARD_H / 2;
        const x1 = Math.min(fromPos.x, toPos.x) + CARD_W;
        const x2 = Math.max(fromPos.x, toPos.x);
        if (x2 > x1) drawHighlightLine(x1, y, x2, y);
      } else {
        // Parent-child link — figure out direction and draw the L-shape
        const fromPerson = people.find(p => p.id === fromId);
        const toPerson = people.find(p => p.id === toId);

        let parentPos, childPos;
        if (toPerson && toPerson.parents.includes(fromId)) {
          parentPos = fromPos;
          childPos = toPos;
        } else if (fromPerson && fromPerson.parents.includes(toId)) {
          parentPos = toPos;
          childPos = fromPos;
        } else {
          // Siblings — route through their shared parent couple's bracket
          const sharedParents = (fromPerson && toPerson) ?
            fromPerson.parents.filter(pid => toPerson.parents.includes(pid)) : [];

          if (sharedParents.length > 0) {
            // Find the couple marriage for the shared parents
            const siblingMarriage = marriages.find(m =>
              sharedParents.some(pid => m.partners.includes(pid)) &&
              m.partners.every(pid => fromPerson.parents.includes(pid) || toPerson.parents.includes(pid))
            ) || marriages.find(m => sharedParents.some(pid => m.partners.includes(pid)));

            if (siblingMarriage) {
              const pos1 = currentPositions.get(siblingMarriage.partners[0]);
              const pos2 = currentPositions.get(siblingMarriage.partners[1]);
              if (pos1 && pos2) {
                const marriageY = pos1.y + CARD_H / 2;
                const parentMidX = (pos1.x + pos2.x + CARD_W) / 2;
                const fromTopY = fromPos.y;
                const bracketY = marriageY + (fromTopY - marriageY) * 0.5;
                const fromMidX = fromPos.x + CARD_W / 2;
                const toMidX = toPos.x + CARD_W / 2;

                // Up from "from" to bracket
                drawHighlightLine(fromMidX, fromTopY, fromMidX, bracketY);
                // Across bracket to "to"
                drawHighlightLine(fromMidX, bracketY, toMidX, bracketY);
                // Down to "to"
                drawHighlightLine(toMidX, bracketY, toMidX, toPos.y);
                continue;
              }
            }
          }

          // Final fallback: just connect centers
          drawHighlightLine(
            fromPos.x + CARD_W / 2, fromPos.y + CARD_H / 2,
            toPos.x + CARD_W / 2, toPos.y + CARD_H / 2
          );
          continue;
        }

        // Find the couple that connects parent to child
        const parentId = parentPos === fromPos ? fromId : toId;
        const childId = parentPos === fromPos ? toId : fromId;
        const parentPerson = people.find(p => p.id === parentId);
        const childPerson = people.find(p => p.id === childId);

        // Check if parent is part of a couple that is the child's parent couple
        let coupleMarriage = null;
        if (childPerson && childPerson.parents.length === 2) {
          coupleMarriage = marriages.find(m =>
            m.partners.includes(childPerson.parents[0]) &&
            m.partners.includes(childPerson.parents[1])
          );
        }

        if (coupleMarriage) {
          // Parent is part of a couple — highlight goes: parent center → marriage midpoint → bracket → child
          const [cp1, cp2] = coupleMarriage.partners;
          const pos1 = currentPositions.get(cp1);
          const pos2 = currentPositions.get(cp2);
          if (pos1 && pos2) {
            const marriageY = pos1.y + CARD_H / 2;
            const parentMidX = (pos1.x + pos2.x + CARD_W) / 2;
            const childTopY = childPos.y;
            const childMidX = childPos.x + CARD_W / 2;
            const bracketY = marriageY + (childTopY - marriageY) * 0.5;

            // From parent card center to marriage midpoint (horizontal)
            const thisPX = parentPos.x + CARD_W / 2;
            drawHighlightLine(thisPX, marriageY, parentMidX, marriageY);
            // Down to bracket
            drawHighlightLine(parentMidX, marriageY, parentMidX, bracketY);
            // Across to child X
            drawHighlightLine(parentMidX, bracketY, childMidX, bracketY);
            // Down to child
            drawHighlightLine(childMidX, bracketY, childMidX, childTopY);
          }
        } else {
          // Single parent — L-shape
          const px = parentPos.x + CARD_W / 2;
          const py = parentPos.y + CARD_H;
          const cx = childPos.x + CARD_W / 2;
          const cy = childPos.y;
          if (Math.abs(px - cx) < 2) {
            drawHighlightLine(px, py, cx, cy);
          } else {
            const midY = py + (cy - py) * 0.5;
            drawHighlightLine(px, py, px, midY);
            drawHighlightLine(px, midY, cx, midY);
            drawHighlightLine(cx, midY, cx, cy);
          }
        }
      }
    }
  }

  function drawHighlightLine(x1, y1, x2, y2) {
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("x1", x1);
    line.setAttribute("y1", y1);
    line.setAttribute("x2", x2);
    line.setAttribute("y2", y2);
    line.setAttribute("class", "line-highlight");
    svgLayer.appendChild(line);
  }

  function clearHighlight() {
    const existing = svgLayer.querySelectorAll(".line-highlight");
    for (const el of existing) el.remove();
    const pathCards = treeContainer.querySelectorAll(".selected-path");
    for (const card of pathCards) card.classList.remove("selected-path");
  }

  clearBtn.addEventListener("click", () => {
    hideResult();
    clearSelection();
  });
})();
