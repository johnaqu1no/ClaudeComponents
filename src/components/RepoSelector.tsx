import { open } from "@tauri-apps/plugin-dialog";
import { useAppDispatch, useAppState } from "../stores/app-store";

export function RepoSelector() {
  const { repoPath, phase } = useAppState();
  const dispatch = useAppDispatch();

  const selectRepo = async () => {
    const selected = await open({ directory: true, multiple: false });
    if (selected) {
      dispatch({ type: "SET_REPO", path: selected as string });
    }
  };

  return (
    <div className="repo-selector">
      <button
        onClick={selectRepo}
        disabled={phase === "scanning" || phase === "executing"}
        className="repo-button"
      >
        {repoPath ? "Change Repo" : "Select Repository"}
      </button>
      {repoPath && <span className="repo-path">{repoPath}</span>}
    </div>
  );
}
