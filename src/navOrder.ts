/**
 * The sidebar order: your saved order, with any tab you've never seen slotted in where it sits by
 * default — right after the tab it follows in `defaults` — instead of tacked on at the bottom.
 *
 * Appending was the old behaviour, and it meant a new page landed under everything else for anyone
 * who had ever dragged a tab, which is almost everyone. Unknown ids in `saved` (a tab that has since
 * been removed) are dropped.
 */
export function mergeNavOrder(saved: readonly string[], defaults: readonly string[]): string[] {
	const order = saved.filter((id, i) => defaults.includes(id) && saved.indexOf(id) === i);
	defaults.forEach((id, i) => {
		if (order.includes(id)) return;
		// The nearest tab before it in the default order that's already placed; none means it goes first.
		let anchor = -1;
		for (let j = i - 1; j >= 0 && anchor === -1; j--) anchor = order.indexOf(defaults[j]);
		order.splice(anchor + 1, 0, id);
	});
	return order;
}
