import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Mention from "@tiptap/extension-mention";
import Placeholder from "@tiptap/extension-placeholder";
import { forwardRef, useCallback, useImperativeHandle, useRef } from "react";
import { MentionList, type MentionListRef } from "./MentionList";
import type { ComponentInfo } from "../types";
import type { JSONContent } from "@tiptap/react";
import { ReactRenderer } from "@tiptap/react";
import tippy, { type Instance as TippyInstance } from "tippy.js";

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

export const TaskEditor = forwardRef<TaskEditorRef, TaskEditorProps>(
  ({ components, onSubmit }, ref) => {
    const componentMapRef = useRef(components);
    componentMapRef.current = components;

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
      editable: true,
    });

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
