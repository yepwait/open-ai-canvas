package service

import (
	"context"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

func TestFetchChannelModelsParsesOpenAICatalog(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/models" {
			t.Errorf("path = %q", r.URL.Path)
		}
		if r.Header.Get("Authorization") != "Bearer catalog-key" {
			t.Errorf("Authorization = %q", r.Header.Get("Authorization"))
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":[{"id":"model-z"},{"id":"model-a"},{"id":"model-a"},{"name":"model-b"}]}`))
	}))
	defer server.Close()

	models, err := (&Service{}).fetchChannelModels(context.Background(), channelModelsRequest{
		BaseURL: server.URL, APIKey: "catalog-key", APIFormat: "openai",
	})
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{"model-a", "model-b", "model-z"}; !reflect.DeepEqual(models, want) {
		t.Fatalf("models = %#v, want %#v", models, want)
	}
}

func TestFetchChannelModelsParsesGeminiCatalog(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1beta/models" {
			t.Errorf("path = %q", r.URL.Path)
		}
		if r.Header.Get("x-goog-api-key") != "gemini-key" {
			t.Errorf("x-goog-api-key = %q", r.Header.Get("x-goog-api-key"))
		}
		if r.Header.Get("Authorization") != "" {
			t.Errorf("Authorization = %q", r.Header.Get("Authorization"))
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"models":[{"name":"models/gemini-z"},{"name":"models/gemini-a"}]}`))
	}))
	defer server.Close()

	models, err := (&Service{}).fetchChannelModels(context.Background(), channelModelsRequest{
		BaseURL: server.URL, APIKey: "gemini-key", APIFormat: "gemini",
	})
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{"gemini-a", "gemini-z"}; !reflect.DeepEqual(models, want) {
		t.Fatalf("models = %#v, want %#v", models, want)
	}
}

func TestFetchChannelModelsMapsAuthenticationFailure(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer server.Close()

	_, err := (&Service{}).fetchChannelModels(context.Background(), channelModelsRequest{
		BaseURL: server.URL, APIKey: "invalid-key", APIFormat: "openai",
	})
	if err == nil || !strings.Contains(err.Error(), "API Key") {
		t.Fatalf("error = %v", err)
	}
}

func TestFetchAdminChannelModelsAddsOnlyMissingDisabledModels(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":[{"id":"existing-model"},{"id":"new-model"}]}`))
	}))
	defer server.Close()

	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	sqlDB.SetMaxOpenConns(1)
	if err := db.AutoMigrate(&model.ModelChannel{}, &model.ChannelModel{}); err != nil {
		t.Fatal(err)
	}
	channel := model.ModelChannel{
		ID: "channel-1", Scope: model.ChannelScopeSystem, Enabled: true, Name: "OpenAI",
		BaseURL: server.URL, APIKey: "catalog-key", APIFormat: "openai", InterfaceType: model.ChannelInterfaceOpenAIResponse,
	}
	existing := model.ChannelModel{
		ID: "model-1", ChannelID: channel.ID, ModelKey: "existing-model", DisplayName: "Existing",
		Capability: "text", BillingMode: "fixed_request", UnitPriceMicrocredits: 123, PriceConfigured: true, Enabled: true, PriceVersion: 2,
	}
	if err := db.Create(&channel).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&existing).Error; err != nil {
		t.Fatal(err)
	}

	svc := &Service{repo: repository.New(db)}
	admin := &model.User{ID: "admin-1", Role: model.UserRoleAdmin, Status: model.UserStatusActive}
	result, err := svc.FetchAdminChannelModels(context.Background(), admin, channel.ID)
	if err != nil {
		t.Fatal(err)
	}
	if result.Added != 1 || !reflect.DeepEqual(result.Models, []string{"existing-model", "new-model"}) {
		t.Fatalf("result = %#v", result)
	}

	items, err := svc.repo.ChannelModels(channel.ID, true)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 2 {
		t.Fatalf("models = %#v", items)
	}
	byKey := map[string]model.ChannelModel{}
	for _, item := range items {
		byKey[item.ModelKey] = item
	}
	if stored := byKey["existing-model"]; !stored.Enabled || !stored.PriceConfigured || stored.UnitPriceMicrocredits != 123 || stored.PriceVersion != 2 {
		t.Fatalf("existing model was overwritten: %#v", stored)
	}
	if added := byKey["new-model"]; added.Enabled || added.PriceConfigured || added.UnitPriceMicrocredits != 0 || added.Capability != "text" {
		t.Fatalf("new model defaults = %#v", added)
	}

	second, err := svc.FetchAdminChannelModels(context.Background(), admin, channel.ID)
	if err != nil {
		t.Fatal(err)
	}
	if second.Added != 0 {
		t.Fatalf("second fetch added = %d", second.Added)
	}
}
