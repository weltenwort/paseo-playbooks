import { useRpc, useTranslation } from "@getpaseo/plugin/client";
import { Icon, ScrollView, TextInput, useToast } from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { listProjectProfilesRpc, listRepositoriesRpc, setProfileRpc, setRepositoryRpc } from "../shared/contracts";
import type { ProfileInfo } from "../shared/types";
import { messages } from "./i18n";
import type { Theme } from "./theme";
import { semanticColor } from "./semantic-colors";

/** Turns a profile on or off for a whole project, then refreshes every view of it (the Profiles tab and each open Playbooks panel). */
export function useSetProjectProfile(): (projectId: string, profile: string, active: boolean) => Promise<void> {
  const setProfile = useRpc(setProfileRpc);
  const queryClient = useQueryClient();
  const toast = useToast();
  return async (projectId, profile, active) => {
    try {
      await setProfile({ projectId, profile, active });
    } catch (error) {
      toast.show((error as Error).message);
    }
    await queryClient.invalidateQueries({ queryKey: ["playbooks"] });
  };
}

const chipStyle = (theme: Theme) => ({ borderRadius: 10, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface1, paddingHorizontal: 8, paddingVertical: 2 }) as const;

/**
 * A project's profiles as a multi-select dropdown: the active ones are chips, and the menu has a
 * checkbox per repository: `default` (on unless turned off) and each profile found in the project's main checkout. The same control is in the Profiles tab and in the panel's bar.
 */
export function ProfilePicker(props: { theme: Theme; label: string; profiles: ProfileInfo[]; onToggle(profile: string, active: boolean): void; zIndex?: number }) {
  const { theme, profiles } = props;
  const { t } = useTranslation(messages);
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState<string | null>(null);
  const muted = theme.colors.foregroundMuted;
  const active = profiles.filter((profile) => profile.active);
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap", zIndex: props.zIndex ?? 10 }}>
      <View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("detail.profiles.pickerLabel", { label: props.label })}
          accessibilityState={{ expanded: open }}
          onPress={() => setOpen(!open)}
          style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap", borderRadius: 8, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: open ? theme.colors.surface2 : theme.colors.surface1, paddingHorizontal: 8, paddingVertical: 4, minWidth: 180 }}
        >
          {active.map((profile) => (
            <View key={profile.id} style={chipStyle(theme)}>
              <Text style={{ color: theme.colors.foreground, fontSize: 11 }}>{profile.id}</Text>
            </View>
          ))}
          {active.length === 0 ? <Text style={{ color: muted, fontSize: 11 }}>{t("detail.profiles.noneActive")}</Text> : null}
          <View style={{ flex: 1 }} />
          <Icon name={open ? "ChevronUp" : "ChevronDown"} size={12} color={muted} />
        </Pressable>
        {open ? (
          <View
            accessibilityRole="menu"
            style={{ position: "absolute", top: 34, left: 0, minWidth: 220, maxHeight: 260, padding: 4, borderRadius: 10, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface2, elevation: 6 }}
          >
            <ScrollView>
              {profiles.length === 0 ? <Text style={{ color: muted, fontSize: 11, paddingHorizontal: 10, paddingVertical: 6 }}>{t("detail.profiles.empty")}</Text> : null}
              {profiles.map((profile) => {
                // An external repository is always on: shown checked and locked (it is managed under External repositories).
                const locked = profile.source === "external";
                return (
                <Pressable
                  key={profile.id}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: profile.active, disabled: locked }}
                  accessibilityLabel={locked ? t("detail.profiles.externalLabel", { id: profile.id }) : t("detail.profiles.profileLabel", { id: profile.id })}
                  disabled={locked}
                  onPress={() => props.onToggle(profile.id, !profile.active)}
                  onHoverIn={() => setHover(profile.id)}
                  onHoverOut={() => setHover((id) => (id === profile.id ? null : id))}
                  style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 10, paddingVertical: 7, borderRadius: 6, backgroundColor: hover === profile.id ? theme.colors.surface1 : "transparent" }}
                >
                  <Icon name={locked ? "Lock" : profile.active ? "SquareCheck" : "Square"} size={14} color={profile.active ? theme.colors.accent : muted} />
                  <Text style={{ color: theme.colors.foreground, fontSize: 13 }}>{profile.id}</Text>
                  <Text style={{ color: muted, fontSize: 11 }}>{t("detail.profiles.playbooks", { count: profile.playbooks })}</Text>
                  {locked ? <Text style={{ color: muted, fontSize: 11 }}>{t("detail.profiles.external")}</Text> : null}
                </Pressable>
                );
              })}
            </ScrollView>
          </View>
        ) : null}
      </View>
    </View>
  );
}

/**
 * The external playbook repositories of this host (ADR 2026-11-26-external-playbook-repositories): one row each, with
 * its folder, playbook count and problem, a Remove button, and a form to add one. Always active in every project.
 */
export function ExternalRepositories(props: { theme: Theme }) {
  const { theme } = props;
  const { t } = useTranslation(messages);
  const list = useRpc(listRepositoriesRpc);
  const setRepository = useRpc(setRepositoryRpc);
  const queryClient = useQueryClient();
  const toast = useToast();
  const [id, setId] = useState("");
  const [folder, setFolder] = useState("");
  const [busy, setBusy] = useState(false);
  const query = useQuery({ queryKey: ["playbooks", "repositories"], queryFn: () => list({}), refetchInterval: 30_000 });
  const muted = theme.colors.foregroundMuted;
  const input = { borderRadius: 8, borderWidth: 1, borderColor: theme.colors.border, paddingHorizontal: 8, paddingVertical: 6, color: theme.colors.foreground, backgroundColor: theme.colors.surface2, minWidth: 160 } as const;
  const change = async (repository: string, where: string | null) => {
    setBusy(true);
    try {
      await setRepository({ id: repository, path: where });
      toast.show(t(where === null ? "detail.repositories.removed" : "detail.repositories.added", { id: repository }), { variant: "success" });
      if (where !== null) {
        setId("");
        setFolder("");
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
    await queryClient.invalidateQueries({ queryKey: ["playbooks"] });
  };
  const repositories = query.data?.repositories ?? [];
  return (
    <View style={{ gap: 6, padding: 10, borderRadius: 10, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface1 }}>
      <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600" }}>{t("detail.repositories.heading")}</Text>
      <Text style={{ color: muted, fontSize: 12 }}>{t("detail.repositories.intro")}</Text>
      {query.error ? <Text style={{ color: semanticColor(theme, "failed") }}>{(query.error as Error).message}</Text> : null}
      {query.data && repositories.length === 0 ? <Text style={{ color: muted, fontSize: 11 }}>{t("detail.repositories.empty")}</Text> : null}
      {repositories.map((repository) => (
        <View key={repository.id} style={{ gap: 2 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <View style={chipStyle(theme)}>
              <Text style={{ color: theme.colors.foreground, fontSize: 11 }}>{repository.id}</Text>
            </View>
            <Text style={{ color: theme.colors.foreground, fontSize: 12 }}>{repository.path}</Text>
            <Text style={{ color: muted, fontSize: 11 }}>{t("detail.profiles.playbooks", { count: repository.playbooks })}</Text>
            <View style={{ flex: 1 }} />
            <Pressable accessibilityRole="button" accessibilityLabel={t("detail.repositories.removeLabel", { id: repository.id })} disabled={busy} onPress={() => void change(repository.id, null)} style={{ borderRadius: 7, borderWidth: 1, borderColor: theme.colors.border, paddingHorizontal: 10, paddingVertical: 4, opacity: busy ? 0.6 : 1 }}>
              <Text style={{ color: theme.colors.foreground, fontSize: 11 }}>{t("detail.repositories.remove")}</Text>
            </Pressable>
          </View>
          {repository.problem ? <Text style={{ color: semanticColor(theme, "failed"), fontSize: 11 }}>{repository.problem}</Text> : null}
        </View>
      ))}
      {(query.data?.problems ?? []).map((note) => (
        <Text key={note} style={{ color: semanticColor(theme, "failed"), fontSize: 11 }}>
          {note}
        </Text>
      ))}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap", paddingTop: 4 }}>
        <TextInput accessibilityLabel={t("detail.repositories.idLabel")} placeholder={t("detail.repositories.idPlaceholder")} placeholderTextColor={muted} value={id} onChangeText={setId} autoCapitalize="none" style={input} />
        <TextInput accessibilityLabel={t("detail.repositories.pathLabel")} placeholder={t("detail.repositories.pathPlaceholder")} placeholderTextColor={muted} value={folder} onChangeText={setFolder} autoCapitalize="none" style={{ ...input, flex: 1, minWidth: 240 }} />
        <Pressable accessibilityRole="button" accessibilityLabel={t("detail.repositories.addLabel")} disabled={busy || !id.trim() || !folder.trim()} onPress={() => void change(id.trim(), folder.trim())} style={{ borderRadius: 7, paddingHorizontal: 12, paddingVertical: 6, backgroundColor: theme.colors.accent, opacity: busy || !id.trim() || !folder.trim() ? 0.6 : 1 }}>
          <Text style={{ color: theme.colors.accentForeground, fontSize: 12, fontWeight: "600" }}>{t("detail.repositories.add")}</Text>
        </Pressable>
      </View>
    </View>
  );
}

/** The "Profiles" tab of the Playbooks screen: one row per project, each with its picker. */
export function ProfilesView(props: { theme: Theme; workspaces: Array<{ id: string; projectId: string }> }) {
  const { theme } = props;
  const { t } = useTranslation(messages);
  const list = useRpc(listProjectProfilesRpc);
  const setProfile = useSetProjectProfile();
  const input = useMemo(() => {
    const byProject = new Map<string, string>();
    for (const workspace of props.workspaces) if (!byProject.has(workspace.projectId)) byProject.set(workspace.projectId, workspace.id);
    return { workspaces: [...byProject].map(([projectId, workspaceId]) => ({ projectId, workspaceId })).sort((a, b) => a.projectId.localeCompare(b.projectId)) };
  }, [props.workspaces]);
  const query = useQuery({
    queryKey: ["playbooks", "project-profiles", input],
    queryFn: () => list(input),
    enabled: input.workspaces.length > 0,
    refetchInterval: 30_000,
  });
  const projects = [...(query.data?.projects ?? [])].sort((a, b) => a.label.localeCompare(b.label));
  return (
    <View style={{ gap: 10 }}>
      <ExternalRepositories theme={theme} />
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
        {t("detail.profiles.intro")}
      </Text>
      {query.error ? <Text style={{ color: semanticColor(theme, "failed") }}>{(query.error as Error).message}</Text> : null}
      {query.isLoading ? <Text style={{ color: theme.colors.foregroundMuted }}>{t("common.loading")}</Text> : null}
      {projects.map((project, index) => (
        <View key={project.projectId} style={{ zIndex: projects.length - index, gap: 6, padding: 10, borderRadius: 10, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface1 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600", minWidth: 120 }}>{project.label}</Text>
            <ProfilePicker theme={theme} label={project.label} profiles={project.profiles} onToggle={(profile, active) => void setProfile(project.projectId, profile, active)} zIndex={projects.length - index} />
          </View>
          {project.diagnostics.map((note) => (
            <Text key={note} style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
              {note}
            </Text>
          ))}
        </View>
      ))}
    </View>
  );
}
