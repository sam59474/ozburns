/**
 * App Controller
 * Custom family-tree layout engine + tap-to-compare interaction.
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

  // Card dimensions
  const CARD_W = 110;
  const CARD_H = 48;
  const COUPLE_GAP = 10;  // gap between married partners
  const SIBLING_GAP = 16; // gap between siblings/units in same family
  const FAMILY_GAP = 40;  // gap between unrelated family units on same rank
  const RANK_SEP = 90;    // vertical distance between generations

  // Load family data
  try {
    const response = await fetch("data/family.jsonc");
    const text = await response.text();
    const cleaned = text
      .replace(/\/\/.*$/gm, "")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    familyData = JSON.parse(cleaned);
    relationshipGraph = new FamilyGraph(familyData);
    renderTree();
  } catch (err) {
    treeContainer.innerHTML = `<p class="error">Failed to load family data. Please try refreshing.</p>`;
    console.error("Error loading family data:", err);
    return;
  }

  // ==========================================================================
  // LAYOUT ENGINE
  // ==========================================================================

  function renderTree() {
    const people = familyData.people;
    const marriages = familyData.marriages || [];

    // Step 1: Assign generations (Y ranks)
    const genMap = assignGenerations(people, marriages);

    // Step 2: Build "layout units" per generation
    // A unit is either a couple (two people) or a single person.
    // Units on the same rank are ordered by: parent position first, then data-file order.
    const ranks = buildRanks(people, marriages, genMap);

    // Step 3: Compute X positions bottom-up.
    // Start with the deepest generation, lay them out, then position parents
    // centered above their children.
    const nodePositions = computePositions(ranks, people, marriages);

    // Step 4: Render
    renderCards(nodePositions);
    drawConnections(nodePositions, marriages, people);
  }

  /**
   * Assign generation numbers. People with no parents = determined by marriage
   * partner or default to 0. Children = max(parent gen) + 1.
   */
  function assignGenerations(people, marriages) {
    const genMap = new Map();
    const peopleMap = new Map(people.map(p => [p.id, p]));

    // Iterative: assign children based on parents, reconcile spouses
    // Start with roots at gen 0
    for (const person of people) {
      if (person.parents.length === 0) {
        genMap.set(person.id, 0);
      }
    }

    // Assign children (may take multiple passes for deep trees)
    let changed = true;
    while (changed) {
      changed = false;
      for (const person of people) {
        if (person.parents.length > 0 && !genMap.has(person.id)) {
          let maxParentGen = -1;
          let allParentsAssigned = true;
          for (const pid of person.parents) {
            if (genMap.has(pid)) {
              maxParentGen = Math.max(maxParentGen, genMap.get(pid));
            } else {
              allParentsAssigned = false;
            }
          }
          if (allParentsAssigned && maxParentGen >= 0) {
            genMap.set(person.id, maxParentGen + 1);
            changed = true;
          }
        }
      }
      // Reconcile spouses
      for (const marriage of marriages) {
        const [p1, p2] = marriage.partners;
        if (genMap.has(p1) && genMap.has(p2)) {
          const max = Math.max(genMap.get(p1), genMap.get(p2));
          if (genMap.get(p1) !== max || genMap.get(p2) !== max) {
            genMap.set(p1, max);
            genMap.set(p2, max);
            changed = true;
          }
        } else if (genMap.has(p1) && !genMap.has(p2)) {
          genMap.set(p2, genMap.get(p1));
          changed = true;
        } else if (genMap.has(p2) && !genMap.has(p1)) {
          genMap.set(p1, genMap.get(p2));
          changed = true;
        }
      }
    }

    return genMap;
  }

  /**
   * Build ordered arrays of "units" per rank.
   * A unit = { type: "couple"|"single", ids: [...], width: number }
   * Order: by data-file position. If a person is part of a couple,
   * the couple unit is placed at the position of whichever partner
   * appears first in the data file for this rank.
   */
  function buildRanks(people, marriages, genMap) {
    // Group by generation
    const genGroups = new Map();
    for (const [id, gen] of genMap) {
      if (!genGroups.has(gen)) genGroups.set(gen, []);
      genGroups.get(gen).push(id);
    }

    const sortedGens = [...genGroups.keys()].sort((a, b) => a - b);
    const ranks = [];

    for (const genNum of sortedGens) {
      const genPeople = genGroups.get(genNum);
      const units = [];
      const placed = new Set();

      // Iterate people in data-file order
      for (const person of people) {
        if (!genPeople.includes(person.id) || placed.has(person.id)) continue;

        // Check if this person is part of a couple on this rank
        const marriage = marriages.find(m =>
          m.partners.includes(person.id) &&
          genPeople.includes(m.partners[0]) &&
          genPeople.includes(m.partners[1]) &&
          !placed.has(m.partners[0]) &&
          !placed.has(m.partners[1])
        );

        if (marriage) {
          units.push({
            type: "couple",
            ids: [marriage.partners[0], marriage.partners[1]],
            width: CARD_W * 2 + COUPLE_GAP
          });
          placed.add(marriage.partners[0]);
          placed.add(marriage.partners[1]);
        } else {
          units.push({
            type: "single",
            ids: [person.id],
            width: CARD_W
          });
          placed.add(person.id);
        }
      }

      ranks.push({ genNum, units });
    }

    return ranks;
  }

  /**
   * Compute X positions using a bottom-up approach:
   * 1. Lay out the deepest rank first (left to right, grouped by parent).
   * 2. For each parent rank, center parents above their children.
   * 3. Resolve overlaps on each rank after centering.
   */
  function computePositions(ranks, people, marriages) {
    const positions = new Map(); // id -> { x, y, w, h }
    const peopleMap = new Map(people.map(p => [p.id, p]));

    // Assign Y positions
    for (let i = 0; i < ranks.length; i++) {
      const y = 20 + i * RANK_SEP;
      for (const unit of ranks[i].units) {
        for (const id of unit.ids) {
          positions.set(id, { x: 0, y, w: CARD_W, h: CARD_H });
        }
      }
    }

    // Process bottom-up: lay out each rank, then adjust parents above
    for (let i = ranks.length - 1; i >= 0; i--) {
      const rank = ranks[i];
      layoutRank(rank, positions, people, marriages, i === ranks.length - 1);
    }

    // Final pass: eliminate squiggles by aligning single children with parents.
    // For each single-parent → single-child connection, nudge the child to
    // match the parent's center X (if there's room).
    // Also align single children of couples to the couple midpoint.
    for (const person of people) {
      const pos = positions.get(person.id);
      if (!pos) continue;

      let targetX = null;

      if (person.parents.length === 1) {
        const parentPos = positions.get(person.parents[0]);
        if (parentPos) {
          targetX = parentPos.x + CARD_W / 2 - CARD_W / 2; // align center
        }
      } else if (person.parents.length === 2) {
        // Check if this is the only child of this couple
        const [par1, par2] = person.parents;
        const siblings = people.filter(p =>
          p.parents.includes(par1) && p.parents.includes(par2)
        );
        if (siblings.length === 1) {
          const p1Pos = positions.get(par1);
          const p2Pos = positions.get(par2);
          if (p1Pos && p2Pos) {
            const coupleMidX = (p1Pos.x + p2Pos.x + CARD_W) / 2;
            targetX = coupleMidX - CARD_W / 2;
          }
        }
      }

      if (targetX === null) continue;

      // Only move if the child isn't part of a couple
      const isMarried = marriages.some(m => m.partners.includes(person.id));
      if (isMarried) continue;

      // Check if moving would cause overlap with neighbors on the same rank
      const myRank = ranks.find(r => r.units.some(u => u.ids.includes(person.id)));
      if (!myRank) continue;

      const allOnRank = myRank.units.flatMap(u => u.ids)
        .map(id => ({ id, pos: positions.get(id) }))
        .filter(item => item.pos)
        .sort((a, b) => a.pos.x - b.pos.x);

      const myIdx = allOnRank.findIndex(item => item.id === person.id);
      let canMove = true;

      // Check left neighbor
      if (myIdx > 0) {
        const leftNeighbor = allOnRank[myIdx - 1].pos;
        if (targetX < leftNeighbor.x + leftNeighbor.w + SIBLING_GAP) {
          canMove = false;
        }
      }
      // Check right neighbor
      if (myIdx < allOnRank.length - 1) {
        const rightNeighbor = allOnRank[myIdx + 1].pos;
        if (targetX + CARD_W + SIBLING_GAP > rightNeighbor.x) {
          canMove = false;
        }
      }

      if (canMove) {
        pos.x = targetX;
      }
    }

    return positions;
  }

  /**
   * Lay out a single rank. Center each unit above its children while
   * preserving data-file order within sibling groups. Between different
   * family groups, use parent position to determine order (prevents crossings).
   */
  function layoutRank(rank, positions, people, marriages, isDeepest) {
    const units = rank.units;

    if (isDeepest || true) {
      // Group units by their parent family, then order groups by parent position.
      // Within each group, preserve data-file order.
      const groups = groupUnitsByParent(units, people, marriages, positions);

      let x = 20;
      for (const group of groups) {
        for (const unit of group.units) {
          placeUnit(unit, x, positions);
          x += unit.width + SIBLING_GAP;
        }
        x += FAMILY_GAP - SIBLING_GAP; // extra gap between family groups
      }
      
      // For non-deepest ranks, try to shift groups to center above children
      if (!isDeepest) {
        for (const group of groups) {
          // Compute where this group wants to be (centered above its children)
          let childMin = Infinity, childMax = -Infinity;
          for (const unit of group.units) {
            const range = getDescendantXRange(unit, positions, people, marriages);
            if (range) {
              childMin = Math.min(childMin, range.min);
              childMax = Math.max(childMax, range.max);
            }
          }
          if (childMin === Infinity) continue;
          
          const childCenter = (childMin + childMax) / 2;
          const groupPositions = group.units.flatMap(u => u.ids.map(id => positions.get(id)));
          const groupMin = Math.min(...groupPositions.map(p => p.x));
          const groupMax = Math.max(...groupPositions.map(p => p.x + p.w));
          const groupCenter = (groupMin + groupMax) / 2;
          
          const shift = childCenter - groupCenter;
          // Only shift right (don't shift left into previous groups)
          if (shift > 0) {
            for (const unit of group.units) {
              for (const id of unit.ids) {
                positions.get(id).x += shift;
              }
            }
          }
        }
        // Resolve overlaps after shifting
        resolveOverlaps(rank, positions);
      }
    }
  }

  /**
   * Group units by their parent couple/person. Units that share parents
   * go in the same group. Groups are ordered by parent X position.
   * Within a group, data-file order is preserved.
   */
  function groupUnitsByParent(units, people, marriages, positions) {
    const groups = []; // [{ parentKey, parentX, units }]
    const unitToGroup = new Map();

    for (const unit of units) {
      // Find the parent key for this unit (the parents of the first blood-related person)
      let parentKey = null;
      let parentX = 0;

      for (const id of unit.ids) {
        const person = people.find(p => p.id === id);
        if (person && person.parents.length > 0) {
          parentKey = person.parents.sort().join("|");
          // Use average parent X for sorting
          let totalX = 0, count = 0;
          for (const pid of person.parents) {
            const ppos = positions.get(pid);
            if (ppos) { totalX += ppos.x; count++; }
          }
          if (count > 0) parentX = totalX / count;
          break;
        }
      }

      if (parentKey === null) {
        // No parents (e.g., spouse married in) — check if partner has parents
        for (const id of unit.ids) {
          const marriage = marriages.find(m => m.partners.includes(id));
          if (marriage) {
            const partnerId = marriage.partners.find(pid => pid !== id);
            const partner = people.find(p => p.id === partnerId);
            if (partner && partner.parents.length > 0) {
              parentKey = partner.parents.sort().join("|");
              let totalX = 0, count = 0;
              for (const pid of partner.parents) {
                const ppos = positions.get(pid);
                if (ppos) { totalX += ppos.x; count++; }
              }
              if (count > 0) parentX = totalX / count;
              break;
            }
          }
        }
      }

      if (parentKey === null) parentKey = "__none_" + unit.ids[0];

      // Find or create group
      let group = groups.find(g => g.parentKey === parentKey);
      if (!group) {
        group = { parentKey, parentX, units: [] };
        groups.push(group);
      }
      group.units.push(unit);
    }

    // Sort groups by parent X position
    groups.sort((a, b) => a.parentX - b.parentX);

    return groups;
  }

  function placeUnit(unit, startX, positions) {
    if (unit.type === "couple") {
      const [id1, id2] = unit.ids;
      positions.get(id1).x = startX;
      positions.get(id2).x = startX + CARD_W + COUPLE_GAP;
    } else {
      positions.get(unit.ids[0]).x = startX;
    }
  }

  /**
   * Get the X range of all descendants of a unit (children, grandchildren etc.)
   * Returns { min, max } of the leftmost and rightmost descendant card edges,
   * or null if no descendants are positioned.
   */
  function getDescendantXRange(unit, positions, people, marriages) {
    // Find immediate children of this unit
    const childIds = [];

    for (const id of unit.ids) {
      for (const person of people) {
        if (person.parents.includes(id) && !childIds.includes(person.id)) {
          childIds.push(person.id);
        }
      }
    }

    // For couples, only include children that belong to BOTH partners
    if (unit.type === "couple") {
      const [p1, p2] = unit.ids;
      const coupleChildren = people.filter(p =>
        p.parents.includes(p1) && p.parents.includes(p2)
      ).map(p => p.id);

      // Also include children of just one partner
      const allChildren = new Set();
      for (const id of unit.ids) {
        for (const person of people) {
          if (person.parents.includes(id)) {
            allChildren.add(person.id);
          }
        }
      }

      // Use all children related to this unit
      childIds.length = 0;
      for (const cid of allChildren) childIds.push(cid);
    }

    if (childIds.length === 0) return null;

    // Also include spouses of children (they're visually part of the child unit)
    const expandedIds = [...childIds];
    for (const cid of childIds) {
      for (const marriage of marriages) {
        if (marriage.partners.includes(cid)) {
          const spouse = marriage.partners.find(id => id !== cid);
          if (!expandedIds.includes(spouse)) expandedIds.push(spouse);
        }
      }
    }

    let min = Infinity, max = -Infinity;
    for (const cid of expandedIds) {
      const pos = positions.get(cid);
      if (pos && pos.x !== 0) {
        min = Math.min(min, pos.x);
        max = Math.max(max, pos.x + pos.w);
      }
    }

    if (min === Infinity) return null;
    return { min, max };
  }

  function resolveOverlaps(rank, positions) {
    // Get all positioned nodes on this rank, sorted by X
    const y = positions.get(rank.units[0].ids[0]).y;
    const nodesOnRank = [];
    for (const unit of rank.units) {
      for (const id of unit.ids) {
        nodesOnRank.push({ id, pos: positions.get(id) });
      }
    }
    nodesOnRank.sort((a, b) => a.pos.x - b.pos.x);

    for (let i = 1; i < nodesOnRank.length; i++) {
      const prev = nodesOnRank[i - 1].pos;
      const curr = nodesOnRank[i].pos;

      // Check if they're a couple (small gap) or not (bigger gap)
      const prevId = nodesOnRank[i - 1].id;
      const currId = nodesOnRank[i].id;
      const areCouple = familyData.marriages.some(m =>
        m.partners.includes(prevId) && m.partners.includes(currId)
      );
      const minGap = areCouple ? COUPLE_GAP : SIBLING_GAP;

      const minX = prev.x + prev.w + minGap;
      if (curr.x < minX) {
        const shift = minX - curr.x;
        // Shift this and all subsequent nodes
        for (let j = i; j < nodesOnRank.length; j++) {
          nodesOnRank[j].pos.x += shift;
        }
      }
    }
  }

  // ==========================================================================
  // RENDERING
  // ==========================================================================

  function renderCards(nodePositions) {
    treeContainer.querySelectorAll(".person-card").forEach(el => el.remove());

    for (const person of familyData.people) {
      const pos = nodePositions.get(person.id);
      if (!pos) continue;

      const card = createPersonCard(person);
      card.style.left = pos.x + "px";
      card.style.top = pos.y + "px";
      treeContainer.appendChild(card);
    }

    // Set container size
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

    // Draw marriage connectors
    for (const marriage of marriages) {
      const [p1, p2] = marriage.partners;
      const pos1 = nodePositions.get(p1);
      const pos2 = nodePositions.get(p2);
      if (!pos1 || !pos2) continue;

      const y = pos1.y + CARD_H / 2;
      const x1 = Math.min(pos1.x, pos2.x) + CARD_W;
      const x2 = Math.max(pos1.x, pos2.x);
      if (x2 > x1) {
        drawLine(x1, y, x2, y, "line-marriage");
      }
    }

    // Draw parent-child connectors for couples
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

      const childPositions = children
        .map(c => ({ id: c.id, pos: nodePositions.get(c.id) }))
        .filter(item => item.pos);
      if (childPositions.length === 0) continue;

      const childTopY = childPositions[0].pos.y;

      if (childPositions.length === 1) {
        const cp = childPositions[0].pos;
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

        const childXs = childPositions.map(cp => cp.pos.x + CARD_W / 2).sort((a, b) => a - b);
        const leftX = Math.min(parentMidX, childXs[0]);
        const rightX = Math.max(parentMidX, childXs[childXs.length - 1]);
        drawLine(leftX, bracketY, rightX, bracketY, "line-parent");

        for (const cp of childPositions) {
          const cx = cp.pos.x + CARD_W / 2;
          drawLine(cx, bracketY, cx, childTopY, "line-parent");
        }
      }
    }

    // Draw single-parent connections
    for (const person of people) {
      if (person.parents.length === 1) {
        const parentPos = nodePositions.get(person.parents[0]);
        const childPos = nodePositions.get(person.id);
        if (!parentPos || !childPos) continue;

        const parentBottomX = parentPos.x + CARD_W / 2;
        const parentBottomY = parentPos.y + CARD_H;
        const childTopX = childPos.x + CARD_W / 2;
        const childTopY = childPos.y;

        if (Math.abs(parentBottomX - childTopX) < 2) {
          drawLine(parentBottomX, parentBottomY, childTopX, childTopY, "line-parent");
        } else {
          const midY = parentBottomY + (childTopY - parentBottomY) * 0.5;
          drawLine(parentBottomX, parentBottomY, parentBottomX, midY, "line-parent");
          drawLine(parentBottomX, midY, childTopX, midY, "line-parent");
          drawLine(childTopX, midY, childTopX, childTopY, "line-parent");
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
    resultTextEl.innerHTML = `<span class="name-b">${nameB}</span> is <span class="name-a">${nameA}</span>'s ${relationship}`;
    resultEl.classList.remove("hidden");
  }

  function hideResult() {
    resultEl.classList.add("hidden");
    resultTextEl.innerHTML = "";
  }

  function clearSelection() {
    selectedA = null;
    clearCardSelection();
    statusTextEl.textContent = "Select the first person";
    statusTextEl.classList.remove("has-selection");
    clearBtn.classList.add("hidden");
    hideResult();
  }

  function clearSecondSelection() {
    const cards = treeContainer.querySelectorAll(".person-card.selected-b");
    for (const card of cards) {
      card.classList.remove("selected-b");
    }
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
