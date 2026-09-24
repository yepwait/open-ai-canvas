import { useMemo } from "react";

import { AssetLibraryPickerModal, type AssetLibraryPickerItem } from "@/components/assets/asset-library-picker-modal";
import { useExternalAssetSources } from "@/hooks/use-external-asset-sources";
import { compileCharacterReferencePrompt } from "@/lib/canvas/canvas-character-reference";
import { ASSET_CATEGORY_LABELS, normalizeAssetCategory } from "@/lib/asset-category";
import type { ExternalAssetPickerReference } from "@/lib/plugins/plugin-types";
import { useAssetStore, type Asset } from "@/stores/use-asset-store";

type InsertableAsset = Extract<Asset, { kind: "text" | "image" | "video" | "audio" | "entity" }>;

export type InsertAssetPayload =
    | { kind: "text"; content: string; title: string; assetId?: string }
    | { kind: "image"; dataUrl: string; title: string; url?: string; storageKey?: string; width?: number; height?: number; bytes?: number; mimeType?: string; assetId?: string }
    | { kind: "video"; url: string; title: string; storageKey?: string; width?: number; height?: number; durationMs?: number; hasAudio?: boolean; bytes?: number; mimeType?: string; assetId?: string }
    | { kind: "audio"; url: string; title: string; storageKey?: string; durationMs?: number; bytes?: number; mimeType?: string; assetId?: string }
    | {
          kind: "character";
          title: string;
          assetId: string;
          versionId: string;
          prompt: string;
          aliases: string[];
          definition: Record<string, unknown>;
          coverUrl?: string;
          visualStatus: string;
          voiceStatus: string;
          voiceName?: string;
          voiceProfile?: { name: string; provider: string; language: string; timbre: string };
          voiceInstructions?: string;
          representationResources?: Array<{ resourceId: string; role: string; mediaType?: string }>;
          voiceSampleResourceId?: string;
          domainProjectId?: string;
      };

type Props = {
    open: boolean;
    multiple?: boolean;
    onInsert: (payloads: InsertAssetPayload[]) => Promise<void> | void;
    onClose: () => void;
};

const categoryLabels: Record<string, string> = { all: "全部素材", ...ASSET_CATEGORY_LABELS, archived: "回收站" };

export function AssetPickerModal({ open, multiple = true, onInsert, onClose }: Props) {
    const assets = useAssetStore((state) => state.assets);
    const externalAssetSources = useExternalAssetSources(open);
    const insertableAssets = useMemo(() => assets.filter((asset): asset is InsertableAsset => asset.kind === "text" || asset.kind === "image" || asset.kind === "video" || asset.kind === "audio" || asset.kind === "entity"), [assets]);
    const items = useMemo<AssetLibraryPickerItem[]>(
        () => [
            ...insertableAssets.map((asset) => ({
                id: asset.id,
                title: asset.title,
                category: normalizeAssetCategory(asset.category),
                archived: asset.status === "archived",
                kindLabel: asset.kind === "entity" ? "角色卡" : asset.kind === "image" ? "图片" : asset.kind === "video" ? "视频" : asset.kind === "audio" ? "音频" : "文本",
                mediaKind: asset.kind === "entity" ? undefined : asset.kind,
                asset,
                imageUrl: asset.kind === "entity" ? asset.coverUrl : undefined,
                imageFit: asset.kind === "entity" ? ("contain" as const) : undefined,
                description: asset.kind === "entity" ? `${asset.metadata?.characterVisualStatus === "ready" ? "形象就绪" : "角色卡"} · ${asset.metadata?.characterVoiceStatus === "ready" ? "声音已绑定" : "声音按项目版本读取"}` : undefined,
                searchText: (asset.tags || []).join(" "),
            })),
            ...externalAssetSources.items,
        ],
        [externalAssetSources.items, insertableAssets],
    );

    return (
        <AssetLibraryPickerModal
            remoteLibrary
            open={open}
            includeEntities
            mediaKinds={["image", "video", "audio", "text"]}
            items={items}
            categoryLabels={{ ...categoryLabels, ...externalAssetSources.categoryLabels }}
            folders={externalAssetSources.folders}
            footerNote={externalAssetSources.error || undefined}
            multiple={multiple}
            confirmLabel={(count) => `插入已选素材${count ? `（${count}）` : ""}`}
            emptyDescription="先在素材库中添加图片、视频、音频或文本。"
            onClose={onClose}
            onConfirm={async (ids) => {
                await onInsert(assetPickerItemsToInsertPayloads(ids, items));
                onClose();
            }}
        />
    );
}

export function assetPickerItemsToInsertPayloads(ids: string[], items: AssetLibraryPickerItem[]): InsertAssetPayload[] {
    const itemsById = new Map(items.map((item) => [item.id, item]));
    return ids.map((id) => {
        const pickerItem = itemsById.get(id);
        if (!pickerItem) throw new Error("所选素材已不存在，请重新选择");
        if (pickerItem.external) return externalAssetToInsertPayload(pickerItem.external);
        const asset = pickerItem.asset;
        if (!asset || !isInsertableAsset(asset)) {
            throw new Error(`“${pickerItem.title}”不是可插入画布的素材`);
        }
        return localAssetToInsertPayload(asset);
    });
}

function isInsertableAsset(asset: Asset): asset is InsertableAsset {
    return asset.kind === "text" || asset.kind === "image" || asset.kind === "video" || asset.kind === "audio" || asset.kind === "entity";
}

export function localAssetToInsertPayload(asset: InsertableAsset): InsertAssetPayload {
    if (asset.kind === "text") return { kind: "text", content: asset.data.content, title: asset.title, assetId: asset.id };
    if (asset.kind === "entity") {
        const versionId = asset.primaryVersionId || asset.data.versionId;
        if (!versionId) throw new Error(`角色卡“${asset.title}”缺少当前版本，请从项目资产重新导入`);
        const voice = asset.data.voice;
        return {
            kind: "character",
            title: asset.title,
            assetId: asset.id,
            versionId,
            prompt: compileCharacterReferencePrompt(asset.title, asset.data.definition),
            aliases: Array.isArray(asset.data.definition.aliases) ? asset.data.definition.aliases.filter((alias): alias is string => typeof alias === "string") : [],
            definition: asset.data.definition,
            coverUrl: asset.coverUrl || undefined,
            visualStatus: typeof asset.metadata?.characterVisualStatus === "string" ? asset.metadata.characterVisualStatus : "ready",
            voiceStatus: typeof asset.metadata?.characterVoiceStatus === "string" ? asset.metadata.characterVoiceStatus : voice ? "ready" : "missing",
            voiceName: voice?.profile.name,
            voiceProfile: voice?.profile,
            voiceInstructions: voice?.instructions,
            representationResources: asset.data.representations,
            voiceSampleResourceId: voice?.profile.sampleResourceId,
            domainProjectId: typeof asset.metadata?.projectId === "string" ? asset.metadata.projectId : undefined,
        };
    }
    if (asset.kind === "audio") return { kind: "audio", url: asset.data.url, storageKey: asset.data.storageKey, title: asset.title, durationMs: asset.data.durationMs, bytes: asset.data.bytes, mimeType: asset.data.mimeType, assetId: asset.id };
    if (asset.kind === "video")
        return {
            kind: "video",
            url: asset.data.url,
            storageKey: asset.data.storageKey,
            title: asset.title,
            width: asset.data.width,
            height: asset.data.height,
            durationMs: asset.data.durationMs,
            hasAudio: asset.data.hasAudio,
            bytes: asset.data.bytes,
            mimeType: asset.data.mimeType,
            assetId: asset.id,
        };
    return { kind: "image", dataUrl: asset.data.dataUrl, storageKey: asset.data.storageKey, title: asset.title, width: asset.data.width, height: asset.data.height, bytes: asset.data.bytes, mimeType: asset.data.mimeType, assetId: asset.id };
}

export function externalAssetToInsertPayload(reference: ExternalAssetPickerReference): InsertAssetPayload {
    const item = reference.item;
    const url = item.fileUrl || "";
    if (!url) throw new Error(`“${item.title}”暂时无法读取，请先在 Eagle 中确认文件可用`);
    const assetId = `external:${reference.sourceId}:${item.id}`;
    if (item.kind === "image") return { kind: "image", dataUrl: url, url, title: item.title || "素材图片", width: item.width, height: item.height, bytes: item.bytes, mimeType: item.mimeType, assetId };
    if (item.kind === "video") return { kind: "video", url, title: item.title, width: item.width, height: item.height, bytes: item.bytes, mimeType: item.mimeType, assetId };
    if (item.kind === "audio") return { kind: "audio", url, title: item.title, bytes: item.bytes, mimeType: item.mimeType, assetId };
    throw new Error(`“${item.title}”不是可插入画布的媒体文件`);
}
