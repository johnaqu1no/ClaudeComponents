import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Mention from "@tiptap/extension-mention";
import Placeholder from "@tiptap/extension-placeholder";
import { Node } from "@tiptap/core";
import { forwardRef, useCallback, useImperativeHandle, useRef } from "react";
import { MentionList, type MentionListRef } from "./MentionList";
import { useAppState } from "../stores/app-store";
import type { ComponentInfo } from "../types";
import type { JSONContent } from "@tiptap/react";
import { ReactRenderer } from "@tiptap/react";
import tippy, { type Instance as TippyInstance } from "tippy.js";
import { invoke } from "@tauri-apps/api/core";

interface TaskEditorProps {
  components: ComponentInfo[];
  onSubmit: (json: JSONContent) => void;
}

export interface TaskEditorRef {
  getJSON: () => JSONContent | undefined;
  focus: () => void;
  insertMention: (name: string, elementSelector?: string) => void;
  clear: () => void;
  getText: () => string;
  setContent: (content: JSONContent) => void;
}

const PastedImage = Node.create({
  name: "pastedImage",
  group: "inline",
  inline: true,
  atom: true,

  addAttributes() {
    return {
      src: { default: null },
      filePath: { default: null },
    };
  },

  parseHTML() {
    return [{ tag: "img[data-pasted-image]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "img",
      {
        ...HTMLAttributes,
        "data-pasted-image": "",
        class: "pasted-image-node",
        src: HTMLAttributes.src,
        draggable: "false",
      },
    ];
  },
});

export const TaskEditor = forwardRef<TaskEditorRef, TaskEditorProps>(
  ({ components, onSubmit }, ref) => {
    const { repoPath } = useAppState();
    const componentMapRef = useRef(components);
    componentMapRef.current = components;
    const repoPathRef = useRef(repoPath);
    repoPathRef.current = repoPath;
    const editorRef = useRef<ReturnType<typeof useEditor>>(null);

    const editor = useEditor({
      extensions: [
        StarterKit.configure({
          heading: false,
          blockquote: false,
          codeBlock: false,
          horizontalRule: false,
          bulletList: false,
          orderedList: false,
          listItem: false,
        }),
        Placeholder.configure({
          placeholder:
            "Describe your task... Use @ to reference components",
        }),
        PastedImage,
        Mention.configure({
          HTMLAttributes: {
            class: "mention-chip",
          },
          suggestion: {
            char: "@",
            items: ({ query }) => {
              return componentMapRef.current
                .filter((c) =>
                  c.name.toLowerCase().includes(query.toLowerCase())
                )
                .slice(0, 8);
            },
            render: () => {
              let renderer: ReactRenderer<MentionListRef> | null = null;
              let popup: TippyInstance[] | null = null;

              return {
                onStart: (props) => {
                  renderer = new ReactRenderer(MentionList, {
                    props,
                    editor: props.editor,
                  });

                  const getReferenceClientRect = props.clientRect;
                  if (!getReferenceClientRect) return;

                  popup = tippy("body", {
                    getReferenceClientRect: getReferenceClientRect as () => DOMRect,
                    appendTo: () => document.body,
                    content: renderer.element,
                    showOnCreate: true,
                    interactive: true,
                    trigger: "manual",
                    placement: "bottom-start",
                  });
                },
                onUpdate: (props) => {
                  renderer?.updateProps(props);
                  if (popup?.[0] && props.clientRect) {
                    popup[0].setProps({
                      getReferenceClientRect: props.clientRect as () => DOMRect,
                    });
                  }
                },
                onKeyDown: (props) => {
                  if (props.event.key === "Escape") {
                    popup?.[0]?.hide();
                    return true;
                  }
                  return renderer?.ref?.onKeyDown(props) ?? false;
                },
                onExit: () => {
                  popup?.[0]?.destroy();
                  renderer?.destroy();
                },
              };
            },
          },
        }),
      ],
      editorProps: {
        handlePaste: (_view, event) => {
          const items = event.clipboardData?.items;
          if (!items) return false;

          for (const item of items) {
            if (!item.type.startsWith("image/")) continue;

            const repo = repoPathRef.current;
            if (!repo) continue;

            const blob = item.getAsFile();
            if (!blob) continue;

            event.preventDefault();

            const uuid = crypto.randomUUID();
            const ext =
              item.type === "image/png"
                ? "png"
                : item.type === "image/jpeg"
                  ? "jpg"
                  : "png";
            const fileName = `${uuid}.${ext}`;
            const dirPath = `${repo}/.claude-components/images`;
            const filePath = `${dirPath}/${fileName}`;

            // Start reading blob data immediately (before event/blob can be GC'd)
            const bufferPromise = blob.arrayBuffer();

            // Insert thumbnail immediately for visual feedback
            const objectUrl = URL.createObjectURL(blob);
            setTimeout(() => {
              editorRef.current
                ?.chain()
                .focus()
                .insertContent({
                  type: "pastedImage",
                  attrs: { src: objectUrl, filePath },
                })
                .run();
            }, 0);

            // Save file to disk via Rust backend
            bufferPromise.then(async (buffer) => {
              await invoke("write_binary_file", {
                path: filePath,
                data: Array.from(new Uint8Array(buffer)),
              });
            }).catch((err) => {
              console.error("Failed to save pasted image:", err);
            });

            return true;
          }
          return false;
        },
      },
      editable: true,
    });

    editorRef.current = editor;

    useImperativeHandle(ref, () => ({
      getJSON: () => editor?.getJSON(),
      focus: () => editor?.commands.focus(),
      insertMention: (name: string, elementSelector?: string) => {
        const label = elementSelector ? `${name} > ${elementSelector}` : name;
        editor
          ?.chain()
          .focus()
          .insertContent({
            type: "mention",
            attrs: { id: name, label },
          })
          .insertContent(" ")
          .run();
      },
      clear: () => {
        editor?.commands.clearContent();
      },
      getText: () => {
        return editor?.getText() ?? "";
      },
      setContent: (content: JSONContent) => {
        editor?.commands.setContent(content);
      },
    }));

    const handleKeyDown = useCallback(
      (e: React.KeyboardEvent) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          const json = editor?.getJSON();
          if (json) onSubmit(json);
        }
      },
      [editor, onSubmit]
    );

    return (
      <div className="task-editor" onKeyDown={handleKeyDown}>
        <EditorContent editor={editor} />
      </div>
    );
  }
);
