class AddOnlyCorrectToDatasets < ActiveRecord::Migration[7.1]
  def change
    add_column :datasets, :only_correct, :boolean, default: false, null: false
  end
end
