/**
 * App Controller
 * Renders a visual family tree using dagre for layout.
 * Handles tap-to-compare interaction.
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

  function renderTree() {
    // Build a dagre graph
    const g = new dagre.graphlib.Graph({ compound: true });
    g.setGraph({
      rankdir: "TB",    // top to bottom
      ranksep: 50,      // vertical gap between generations
      nodesep: 16,      // horizontal gap between nodes
      edgesep: 10,
      marginx: 10,
      marginy: 10
    });
    g.setDefaultEdgeLabel(function () { return {}; });

    const marriages = familyData.marriages || [];
    const people = familyData.people;

    // For each married couple, create a "couple node" (invisible, small)
    // that both partners connect to, and children connect from.
    // This keeps partners adjacent and routes children through the couple midpoint.
    const coupleNodes = new Map(); // "p1|p2" -> coupleNodeId

    for (const marriage of marriages) {
      const [p1, p2] = marriage.partners;
      const coupleId = `couple_${p1}_${p2}`;
      coupleNodes.set(`${p1}|${p2}`, coupleId);
      coupleNodes.set(`${p2}|${p1}`, coupleId);
      g.setNode(coupleId, { width: 1, height: 1 });
    }

    // Add all person nodes
    for (const person of people) {
      g.setNode(person.id, { width: CARD_W, height: CARD_H, person: person });
    }

    // Add edges: partner → couple node (keeps them on same rank, adjacent)
    for (const marriage of marriages) {
      const [p1, p2] = marriage.partners;
      const coupleId = `couple_${p1}_${p2}`;
      g.setEdge(p1, coupleId, { weight: 2, minlen: 1 });
      g.setEdge(p2, coupleId, { weight: 2, minlen: 1 });
    }

    // Add edges: couple node → children
    for (const person of people) {
      if (person.parents.length === 2) {
        const [par1, par2] = person.parents;
        const coupleId = coupleNodes.get(`${par1}|${par2}`);
        if (coupleId) {
          g.setEdge(coupleId, person.id, { weight: 1, minlen: 1 });
        }
      } else if (person.parents.length === 1) {
        // Use minlen 2 to match the 2-hop path (parent → couple → child)
        // so single-parent children land on the same rank as two-parent children
        g.setEdge(person.parents[0], person.id, { weight: 1, minlen: 2 });
      }
    }

    // Run dagre layout
    dagre.layout(g);

    // Clear previous cards
    treeContainer.querySelectorAll(".person-card").forEach(el => el.remove());
    treeContainer.querySelectorAll(".couple-dot").forEach(el => el.remove());

    // Render person cards at computed positions
    const nodePositions = new Map(); // id -> {x, y, width, height}

    for (const nodeId of g.nodes()) {
      const node = g.node(nodeId);
      if (!node) continue;

      nodePositions.set(nodeId, {
        x: node.x - node.width / 2,
        y: node.y - node.height / 2,
        cx: node.x,
        cy: node.y,
        width: node.width,
        height: node.height
      });

      // Only render cards for actual people (not couple nodes)
      if (node.person) {
        const card = createPersonCard(node.person);
        card.style.left = (node.x - node.width / 2) + "px";
        card.style.top = (node.y - node.height / 2) + "px";
        treeContainer.appendChild(card);
      }
    }

    // Set container size
    const graphInfo = g.graph();
    treeContainer.style.width = (graphInfo.width + 40) + "px";
    treeContainer.style.height = (graphInfo.height + 40) + "px";
    svgLayer.setAttribute("width", graphInfo.width + 40);
    svgLayer.setAttribute("height", graphInfo.height + 40);

    // Draw connectors
    drawConnections(g, nodePositions, marriages);
  }

  function drawConnections(g, nodePositions, marriages) {
    svgLayer.innerHTML = "";

    // Draw marriage connectors (horizontal line between spouses)
    for (const marriage of marriages) {
      const [p1, p2] = marriage.partners;
      const pos1 = nodePositions.get(p1);
      const pos2 = nodePositions.get(p2);
      if (!pos1 || !pos2) continue;

      // Horizontal line at the vertical center of the two spouse cards
      const y = (pos1.cy + pos2.cy) / 2;
      const x1 = Math.min(pos1.cx, pos2.cx) + CARD_W / 2;
      const x2 = Math.max(pos1.cx, pos2.cx) - CARD_W / 2;
      if (x2 > x1) {
        drawLine(x1, y, x2, y, "line-marriage", p1, p2);
      }
    }

    // Draw parent-child connectors
    for (const marriage of marriages) {
      const [p1Id, p2Id] = marriage.partners;
      const coupleId = `couple_${p1Id}_${p2Id}`;
      const couplePos = nodePositions.get(coupleId);
      const pos1 = nodePositions.get(p1Id);
      const pos2 = nodePositions.get(p2Id);
      if (!couplePos || !pos1 || !pos2) continue;

      // Find children of this couple
      const children = familyData.people.filter(p =>
        p.parents.includes(p1Id) && p.parents.includes(p2Id)
      );
      if (children.length === 0) continue;

      // The marriage line sits at the vertical center between spouses
      const marriageY = (pos1.cy + pos2.cy) / 2;
      const parentMidX = (pos1.cx + pos2.cx) / 2;

      // Get child positions
      const childPositions = children
        .map(c => nodePositions.get(c.id))
        .filter(Boolean);
      if (childPositions.length === 0) continue;

      const childTopY = Math.min(...childPositions.map(cp => cp.y));
      const bracketY = marriageY + (childTopY - marriageY) * 0.5;

      // Vertical from marriage line midpoint down to bracket
      // Tag with couple ID so any child path can match
      const coupleTag = `${p1Id}|${p2Id}`;
      drawLine(parentMidX, marriageY, parentMidX, bracketY, "line-parent", coupleTag, "bracket");

      // Horizontal bracket spanning children
      const childXs = childPositions.map(cp => cp.cx).sort((a, b) => a - b);
      const leftX = Math.min(parentMidX, childXs[0]);
      const rightX = Math.max(parentMidX, childXs[childXs.length - 1]);
      drawLine(leftX, bracketY, rightX, bracketY, "line-parent", coupleTag, "bracket");

      // Vertical drops to each child
      for (let i = 0; i < children.length; i++) {
        const cp = nodePositions.get(children[i].id);
        if (cp) {
          drawLine(cp.cx, bracketY, cp.cx, cp.y, "line-parent", coupleTag, children[i].id);
        }
      }
    }

    // Draw single-parent connections
    for (const person of familyData.people) {
      if (person.parents.length === 1) {
        const parentPos = nodePositions.get(person.parents[0]);
        const childPos = nodePositions.get(person.id);
        if (!parentPos || !childPos) continue;

        const parentBottomY = parentPos.y + parentPos.height;
        const midY = parentBottomY + (childPos.y - parentBottomY) * 0.5;

        drawLine(parentPos.cx, parentBottomY, parentPos.cx, midY, "line-parent", person.parents[0], person.id);
        drawLine(parentPos.cx, midY, childPos.cx, midY, "line-parent", person.parents[0], person.id);
        drawLine(childPos.cx, midY, childPos.cx, childPos.y, "line-parent", person.parents[0], person.id);
      }
    }
  }

  function drawLine(x1, y1, x2, y2, className, fromId, toId) {
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("x1", x1);
    line.setAttribute("y1", y1);
    line.setAttribute("x2", x2);
    line.setAttribute("y2", y2);
    if (className) line.setAttribute("class", className);
    if (fromId) line.setAttribute("data-from", fromId);
    if (toId) line.setAttribute("data-to", toId);
    svgLayer.appendChild(line);
  }

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
      // First tap — lock in the base person
      selectedA = personId;
      cardElement.classList.add("selected-a");
      cardElement.setAttribute("aria-selected", "true");
      const person = relationshipGraph.getPerson(personId);
      statusTextEl.innerHTML = `<span style="color: var(--color-selected-a); font-weight: 700;">${person.name}</span> selected \u2014 tap others to see relationships, or `;
      statusTextEl.classList.add("has-selection");
      clearBtn.classList.remove("hidden");
      hideResult();
    } else if (selectedA === personId) {
      // Tapped the base person again — deselect
      clearSelection();
    } else {
      // Tap another person — show relationship, keep base selected
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
    statusTextEl.textContent = "Select a first person";
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
