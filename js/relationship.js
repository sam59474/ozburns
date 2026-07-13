/**
 * Relationship Calculator
 * 
 * Given a family graph, finds the relationship between any two people
 * by locating their lowest common ancestor(s) and computing generational
 * distances, then translating to English kinship terms.
 */

class FamilyGraph {
  constructor(data) {
    this.people = new Map();
    this.marriages = data.marriages || [];
    this.siblingGroups = data.siblings || [];

    for (const person of data.people) {
      this.people.set(person.id, {
        ...person,
        children: []
      });
    }

    // Build children references from parent links
    for (const person of data.people) {
      for (const parentId of person.parents) {
        const parent = this.people.get(parentId);
        if (parent) {
          parent.children.push(person.id);
        }
      }
    }
  }

  getPerson(id) {
    return this.people.get(id);
  }

  getAllPeople() {
    return Array.from(this.people.values());
  }

  /**
   * Get all parent IDs for a person, including implicit parents
   * from sibling groups.
   */
  getParents(personId) {
    const person = this.people.get(personId);
    if (!person) return [];
    return [...person.parents];
  }

  /**
   * Check if two people are in the same sibling group
   */
  areSiblings(idA, idB) {
    // Check via shared parents
    const parentsA = this.getParents(idA);
    const parentsB = this.getParents(idB);
    if (parentsA.length > 0 && parentsB.length > 0) {
      for (const p of parentsA) {
        if (parentsB.includes(p)) return true;
      }
    }

    // Check via explicit sibling groups
    for (const group of this.siblingGroups) {
      if (group.members.includes(idA) && group.members.includes(idB)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Check if two people are married
   */
  areMarried(idA, idB) {
    for (const marriage of this.marriages) {
      if (marriage.partners.includes(idA) && marriage.partners.includes(idB)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Get spouse ID for a person (first marriage found)
   */
  getSpouse(personId) {
    for (const marriage of this.marriages) {
      if (marriage.partners.includes(personId)) {
        return marriage.partners.find(id => id !== personId);
      }
    }
    return null;
  }

  /**
   * Find all ancestors of a person with their generational distance.
   * Returns a Map of ancestorId -> distance (1 = parent, 2 = grandparent, etc.)
   * Also traverses sibling groups to find shared implicit ancestors.
   */
  getAncestors(personId) {
    const ancestors = new Map();
    const visited = new Set();
    const queue = [{ id: personId, distance: 0 }];

    while (queue.length > 0) {
      const { id, distance } = queue.shift();

      if (visited.has(id)) continue;
      visited.add(id);

      if (distance > 0) {
        if (!ancestors.has(id) || ancestors.get(id) > distance) {
          ancestors.set(id, distance);
        }
      }

      const parents = this.getParents(id);
      for (const parentId of parents) {
        if (!visited.has(parentId)) {
          queue.push({ id: parentId, distance: distance + 1 });
        }
      }
    }

    return ancestors;
  }

  /**
   * Find the relationship between two people.
   * Returns a human-readable string like "brother", "aunt", "second cousin once removed".
   */
  findRelationship(idA, idB) {
    if (idA === idB) return "self";

    // Check direct marriage
    if (this.areMarried(idA, idB)) {
      const personB = this.people.get(idB);
      return this.getSpouseLabel(personB);
    }

    // Check blood relationship first (takes priority over in-law)
    const blood = this.findBloodRelationship(idA, idB);
    if (blood) return blood;

    // Check if B is an in-law (spouse of a blood relative)
    const spouseOfB = this.getSpouse(idB);
    if (spouseOfB && spouseOfB !== idA) {
      const bloodRelationship = this.findBloodRelationship(idA, spouseOfB);
      if (bloodRelationship) {
        return this.toInLaw(bloodRelationship, idB);
      }
    }

    // Check if A's spouse is blood-related to B
    const spouseOfA = this.getSpouse(idA);
    if (spouseOfA && spouseOfA !== idB) {
      const bloodRelationship = this.findBloodRelationship(spouseOfA, idB);
      if (bloodRelationship) {
        return this.toInLaw(bloodRelationship, idB);
      }
    }

    return "not directly related";
  }

  /**
   * Find blood (consanguineal) relationship between two people.
   */
  findBloodRelationship(idA, idB) {
    // Check siblings (including via sibling groups)
    if (this.areSiblings(idA, idB)) {
      const personB = this.people.get(idB);
      return this.getSiblingLabel(personB);
    }

    // Get ancestors of both
    const ancestorsA = this.getAncestors(idA);
    const ancestorsB = this.getAncestors(idB);

    // Check if B is an ancestor of A
    if (ancestorsA.has(idB)) {
      const distance = ancestorsA.get(idB);
      const personB = this.people.get(idB);
      return this.getAncestorLabel(distance, personB);
    }

    // Check if A is an ancestor of B (B is a descendant of A)
    if (ancestorsB.has(idA)) {
      const distance = ancestorsB.get(idA);
      const personB = this.people.get(idB);
      return this.getDescendantLabel(distance, personB);
    }

    // Find common ancestors
    let bestRelationship = null;
    let bestTotal = Infinity;

    // Also check via sibling groups - if A's ancestor is a sibling of B's ancestor
    const commonAncestorRelationship = this.findCommonAncestorViaGroups(idA, idB, ancestorsA, ancestorsB);
    if (commonAncestorRelationship) return commonAncestorRelationship;

    for (const [ancestorId, distA] of ancestorsA) {
      if (ancestorsB.has(ancestorId)) {
        const distB = ancestorsB.get(ancestorId);
        const total = distA + distB;
        if (total < bestTotal) {
          bestTotal = total;
          const personB = this.people.get(idB);
          bestRelationship = this.getCousinLabel(distA, distB, personB);
        }
      }
    }

    return bestRelationship;
  }

  /**
   * Handle relationships through sibling groups where parents aren't explicitly listed.
   */
  findCommonAncestorViaGroups(idA, idB, ancestorsA, ancestorsB) {
    // For each sibling group, check if an ancestor of A is in the same group
    // as an ancestor of B (or B itself)
    for (const group of this.siblingGroups) {
      const membersInA = [];
      const membersInB = [];

      for (const memberId of group.members) {
        if (memberId === idA || ancestorsA.has(memberId)) {
          const dist = memberId === idA ? 0 : ancestorsA.get(memberId);
          membersInA.push({ id: memberId, distance: dist });
        }
        if (memberId === idB || ancestorsB.has(memberId)) {
          const dist = memberId === idB ? 0 : ancestorsB.get(memberId);
          membersInB.push({ id: memberId, distance: dist });
        }
      }

      if (membersInA.length > 0 && membersInB.length > 0) {
        // Find the closest pair
        let bestDistA = Infinity;
        let bestDistB = Infinity;

        for (const a of membersInA) {
          for (const b of membersInB) {
            if (a.id !== b.id && a.distance + b.distance < bestDistA + bestDistB) {
              bestDistA = a.distance;
              bestDistB = b.distance;
            }
          }
        }

        if (bestDistA !== Infinity) {
          // They connect through siblings, so add 1 to treat the sibling connection
          // like going up to a shared parent and back down
          const personB = this.people.get(idB);
          return this.getCousinLabel(bestDistA + 1, bestDistB + 1, personB);
        }
      }
    }

    return null;
  }

  /**
   * Get label for a spouse
   */
  getSpouseLabel(person) {
    if (person.gender === "M") return "husband";
    if (person.gender === "F") return "wife";
    return "spouse";
  }

  /**
   * Get label for a sibling
   */
  getSiblingLabel(person) {
    if (person.gender === "M") return "brother";
    if (person.gender === "F") return "sister";
    return "sibling";
  }

  /**
   * Get label for an ancestor at given distance.
   * distance 1 = parent, 2 = grandparent, 3 = great-grandparent
   */
  getAncestorLabel(distance, person) {
    const base = person.gender === "M" ? "father" : person.gender === "F" ? "mother" : "parent";
    if (distance === 1) return base;
    const grandBase = person.gender === "M" ? "grandfather" : person.gender === "F" ? "grandmother" : "grandparent";
    if (distance === 2) return grandBase;
    const greats = distance - 2;
    return "great-".repeat(greats) + grandBase;
  }

  /**
   * Get label for a descendant at given distance.
   * distance 1 = child, 2 = grandchild, 3 = great-grandchild
   */
  getDescendantLabel(distance, person) {
    const base = person.gender === "M" ? "son" : person.gender === "F" ? "daughter" : "child";
    if (distance === 1) return base;
    const grandBase = person.gender === "M" ? "grandson" : person.gender === "F" ? "granddaughter" : "grandchild";
    if (distance === 2) return grandBase;
    const greats = distance - 2;
    return "great-".repeat(greats) + grandBase;
  }

  /**
   * Get cousin/aunt/uncle/niece/nephew label based on generational distances.
   * distA = generations from person A up to common ancestor
   * distB = generations from person B up to common ancestor
   */
  getCousinLabel(distA, distB, personB) {
    // Same generation: siblings (1,1), first cousins (2,2), second cousins (3,3)...
    if (distA === distB) {
      if (distA === 1) return this.getSiblingLabel(personB);
      const degree = distA - 1;
      return this.formatCousin(degree, 0);
    }

    // Different generations
    const minDist = Math.min(distA, distB);
    const maxDist = Math.max(distA, distB);
    const removal = maxDist - minDist;

    if (minDist === 1) {
      // Direct line aunt/uncle or niece/nephew
      if (distA < distB) {
        // B is further from common ancestor = B is a niece/nephew
        const base = personB.gender === "M" ? "nephew" : personB.gender === "F" ? "niece" : "nibling";
        if (removal === 1) return base;
        if (removal === 2) return "great-" + base;
        return "great-".repeat(removal - 1) + base;
      } else {
        // A is further from common ancestor = B is an aunt/uncle
        const base = personB.gender === "M" ? "uncle" : personB.gender === "F" ? "aunt" : "pibling";
        if (removal === 1) return base;
        if (removal === 2) return "great-" + base;
        return "great-".repeat(removal - 1) + base;
      }
    }

    // Cousin with removal
    const degree = minDist - 1;
    return this.formatCousin(degree, removal);
  }

  /**
   * Format a cousin relationship string.
   * degree: 1 = first cousin, 2 = second cousin, etc.
   * removal: 0 = same generation, 1 = once removed, etc.
   */
  formatCousin(degree, removal) {
    const ordinal = this.ordinal(degree);
    let label = `${ordinal} cousin`;
    if (removal > 0) {
      label += ` ${this.timesRemoved(removal)}`;
    }
    return label;
  }

  /**
   * Convert number to ordinal: 1 -> "first", 2 -> "second", etc.
   */
  ordinal(n) {
    const ordinals = [
      "", "first", "second", "third", "fourth", "fifth",
      "sixth", "seventh", "eighth", "ninth", "tenth"
    ];
    if (n < ordinals.length) return ordinals[n];
    return n + "th";
  }

  /**
   * Format the "times removed" string.
   */
  timesRemoved(n) {
    if (n === 1) return "once removed";
    if (n === 2) return "twice removed";
    const words = [
      "", "", "", "thrice", "four times", "five times",
      "six times", "seven times", "eight times", "nine times", "ten times"
    ];
    if (n < words.length) return `${words[n]} removed`;
    return `${n} times removed`;
  }

  /**
   * Convert a relationship to in-law version
   */
  toInLaw(relationship, personId) {
    const person = this.people.get(personId);
    const g = person ? person.gender : null;

    // Siblings-in-law
    if (relationship === "brother" || relationship === "sister" || relationship === "sibling") {
      if (g === "M") return "brother-in-law";
      if (g === "F") return "sister-in-law";
      return "sibling-in-law";
    }

    // Parents-in-law
    if (relationship === "father" || relationship === "mother" || relationship === "parent") {
      if (g === "M") return "father-in-law";
      if (g === "F") return "mother-in-law";
      return "parent-in-law";
    }

    // Children-in-law
    if (relationship === "son" || relationship === "daughter" || relationship === "child") {
      if (g === "M") return "son-in-law";
      if (g === "F") return "daughter-in-law";
      return "child-in-law";
    }

    // Aunts/uncles-in-law
    if (relationship === "uncle" || relationship === "aunt" || relationship === "pibling") {
      if (g === "M") return "uncle (by marriage)";
      if (g === "F") return "aunt (by marriage)";
      return "pibling (by marriage)";
    }

    // Nieces/nephews-in-law
    if (relationship === "nephew" || relationship === "niece" || relationship === "nibling") {
      if (g === "M") return "nephew (by marriage)";
      if (g === "F") return "niece (by marriage)";
      return "nibling (by marriage)";
    }

    // Everything else (great-aunts, cousins, etc.)
    return relationship + " (by marriage)";
  }

  /**
   * Get a natural language description: "B is A's ___"
   */
  describe(idA, idB) {
    const personA = this.people.get(idA);
    const personB = this.people.get(idB);
    if (!personA || !personB) return "Unknown person selected.";
    if (idA === idB) return `That's the same person!`;

    const relationship = this.findRelationship(idA, idB);
    return `${personB.name} is ${personA.name}'s ${relationship}`;
  }

  /**
   * Find the shortest path between two people through parent-child
   * and marriage edges. Returns an array of person IDs from idA to idB,
   * or an empty array if no path exists.
   */
  findPath(idA, idB) {
    if (idA === idB) return [idA];

    // BFS through the family graph treating parent-child and marriage as edges
    const visited = new Set();
    const queue = [[idA]];
    visited.add(idA);

    while (queue.length > 0) {
      const path = queue.shift();
      const current = path[path.length - 1];

      // Get all neighbors: parents, children, and spouse
      const neighbors = [];

      const person = this.people.get(current);
      if (person) {
        // Parents
        for (const parentId of person.parents) {
          neighbors.push(parentId);
        }
        // Children
        if (person.children) {
          for (const childId of person.children) {
            neighbors.push(childId);
          }
        }
      }

      // Spouse
      const spouse = this.getSpouse(current);
      if (spouse) {
        neighbors.push(spouse);
      }

      for (const neighbor of neighbors) {
        if (visited.has(neighbor)) continue;
        const newPath = [...path, neighbor];
        if (neighbor === idB) return newPath;
        visited.add(neighbor);
        queue.push(newPath);
      }
    }

    return [];
  }
}
