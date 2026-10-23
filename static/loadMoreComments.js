// @license http://www.gnu.org/licenses/agpl-3.0.html AGPL-3.0
document.addEventListener("click", async (event) => {
    const link = event.target.closest("a.deeper_replies");
    if (!link || event.ctrlKey || event.metaKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    if (link.dataset.loading) return;
    link.dataset.loading = "1";
    const label = link.textContent;
    link.textContent = "Loading…";

    try {
        const response = await fetch(link.href);
        if (!response.ok) throw new Error(response.status);
        const page = new DOMParser().parseFromString(await response.text(), "text/html");
        const comment = link.closest(".comment");
        const parent = comment && page.getElementById(comment.id);
        if (parent) {
            // The link opens the parent comment's thread; its replies replace the
            // link, minus those already on the page.
            const replies = [...parent.querySelector(":scope > details > .replies").children];
            const fresh = replies.filter((reply) => (reply.id ? !document.getElementById(reply.id) : reply.getAttribute("href") !== link.getAttribute("href")));
            if (!fresh.length) throw new Error("no new replies");
            link.replaceWith(...fresh);
            return;
        }
        // A continuation (cursor=) lists what comes next at its top level: the
        // replies of the link's comment (and a link to more of them), or the
        // post's next comments followed by a link to the page after them.
        const threads = [...page.querySelectorAll("#comments > .thread")];
        const isNew = (item) => item && !(item.id && document.getElementById(item.id));
        if (comment) {
            const fresh = threads.map((thread) => thread.querySelector(":scope > .comment, :scope > a.deeper_replies")).filter(isNew);
            if (!fresh.length) throw new Error("no new replies");
            link.replaceWith(...fresh);
        } else {
            const fresh = threads.filter((thread) => isNew(thread.querySelector(":scope > .comment")));
            if (!fresh.length) throw new Error("no new comments");
            document.getElementById("comments").append(...fresh);
            const next = page.querySelector("#comments ~ a.deeper_replies");
            if (next) link.replaceWith(next);
            else link.remove();
        }
    } catch {
        link.textContent = label;
        delete link.dataset.loading;
        window.location.href = link.href;
    }
});
// @license-end
