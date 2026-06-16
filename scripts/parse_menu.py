import pandas as pd
import json
import re
import sys

def clean_name(name):
    return str(name).strip()

def generate_description(item_name, category):
    item_lower = item_name.lower()
    cat_lower = category.lower()
    
    # Coffee & Drinks
    if 'cappuccino' in item_lower:
        return "Classic espresso drink with equal parts espresso, steamed milk, and milk foam."
    elif 'latte' in item_lower:
        flavor = ""
        for f in ['spanish', 'honey', 'vanilla', 'caramel', 'hazelnut', 'maple']:
            if f in item_lower:
                flavor = f.title() + " "
        return f"Rich espresso with steamed milk and a touch of {flavor}sweetness."
    elif 'americano' in item_lower:
        return "Espresso shots diluted with hot water for a smooth, bold flavor."
    elif 'mocha' in item_lower:
        return "Decadent combination of espresso, steamed milk, and rich chocolate syrup."
    elif 'espresso' in item_lower:
        return "Intense and concentrated shot of pure, rich coffee."
    elif 'macchiato' in item_lower:
        return "Espresso marked with a small dollop of foamed milk."
    elif 'flat white' in item_lower:
        return "Espresso with microfoam for a smooth, velvet texture."
    elif 'cortado' in item_lower:
        return "Espresso cut with an equal amount of warm milk."
    elif 'hot chocolate' in item_lower:
        return "Rich and creamy steamed milk blended with premium cocoa."
    elif 'tonic' in item_lower:
        return "Refreshing combination of espresso shot and tonic water over ice."
    elif 'soda' in item_lower:
        return "Unique combination of espresso and carbonated soda water."
    elif 'matcha' in item_lower:
        flavor = ""
        for f in ['kyoto', 'kobe']:
            if f in item_lower:
                flavor = f.title() + " "
        return f"Premium Japanese green tea powder whisked with milk/water, {flavor}style."
    elif 'tea' in item_lower:
        flavor = ""
        for f in ['peach', 'strawberry']:
            if f in item_lower:
                flavor = f.title() + " "
        return f"Refreshing iced tea infused with {flavor}flavor."
    elif 'decaf' in item_lower:
        return "Smooth decaffeinated hot coffee option."
    elif 'affogato' in item_lower:
        return "A scoop of vanilla ice cream drowned in a hot shot of espresso."
    
    # Food & Sandwiches
    elif 'bagel' in item_lower:
        if 'egg' in item_lower:
            return "Hearty breakfast bagel topped with egg and savory sausage."
        return "Freshly baked bagel, perfect with your favorite spread."
    elif 'croissant' in item_lower:
        if 'almond' in item_lower:
            return "Flaky croissant filled and topped with sweet almond frangipane."
        elif 'pistachio' in item_lower:
            return "Delectable flaky croissant filled with rich pistachio cream."
        elif 'butter' in item_lower:
            return "Flaky, buttery, and freshly baked classic croissant."
        return "Freshly baked flaky pastry."
    elif 'cream cheese' in item_lower:
        return "Rich and creamy cream cheese spread."
    elif 'puff' in item_lower:
        return "Savory, golden-brown puff pastry filled with fajita chicken."
    elif 'brushetta' in item_lower:
        return "Crispy toasted bread topped with savory feta cheese and herbs."
    elif 'brisket' in item_lower:
        return "Tender, slow-cooked beef brisket sandwich served on fresh bread."
    elif 'patty melt' in item_lower:
        return "Juicy beef patty with melted cheese and grilled onions in toasted bread."
    elif 'hunter beef' in item_lower:
        return "Traditional spiced, cured hunter beef sandwich."
    elif 'pastrami' in item_lower:
        return "Classic beef pastrami sandwich layered with cheese and mustard."
    elif 'grilled cheese' in item_lower:
        return "Crispy, buttery grilled cheese sandwich with savory bacon."
    elif 'chicken' in item_lower:
        if 'pesto' in item_lower:
            return "Grilled chicken sandwich featuring aromatic basil pesto."
        elif 'jalapeno' in item_lower:
            return "Spicy chicken sandwich topped with sliced jalapenos."
        return "Delicious grilled chicken sandwich."
    
    # Sweet & Cakes
    elif 'pain au chocolat' in item_lower:
        return "Classic French pastry filled with rich dark chocolate."
    elif 'banana bread' in item_lower:
        return "Moist, sweet banana bread slice."
    elif 'brownie' in item_lower:
        return "Rich, fudgy chocolate brownie."
    elif 'cookie' in item_lower:
        return "Delectable fresh-baked cookie."
    elif 'muffin' in item_lower:
        return "Soft, cake-like muffin bursting with sweet blueberries."
    elif 'pecan pie' in item_lower:
        return "Classic dessert pie with a sweet filling and crunchy pecans."
    elif 'cake' in item_lower:
        if 'carrot' in item_lower:
            return "Moist carrot cake with rich cream cheese frosting."
        elif 'coffee' in item_lower:
            return "Spiced cake with a crumbly cinnamon streusel topping."
        elif 'flourless' in item_lower:
            return "Decadent flourless chocolate cake, naturally gluten-free."
        elif 'lisbon' in item_lower:
            return "Rich chocolate Lisbon cake slice, gluten-free."
        elif 'matilda' in item_lower:
            return "Show-stopping, multi-layered chocolate cake."
        return "Delicious slice of fresh cake."
    elif 'bars' in item_lower:
        return "Healthy, sugar-free energy bar packed with nutrients."
    elif 'short bread' in item_lower:
        return "Buttery, crumbly shortbread cookies made with macadamia nuts."
    elif 'pudding' in item_lower:
        if 'date' in item_lower:
            return "Warm date pudding served with sweet butterscotch sauce."
        return "Creamy and delicious banana pudding."
    elif 'protein' in item_lower:
        return "Box of nutritious, protein-packed energy bites."
    
    return f"Fresh and delicious {item_name} from our {category} selection."

def main():
    try:
        df = pd.read_excel('/home/sayyaf/Downloads/Third_Culture_Coffee_Menu_Categorized.xlsx', sheet_name='Third Culture Coffee Menu')
    except Exception as e:
        print(json.dumps({"error": f"Failed to load excel: {str(e)}"}))
        sys.exit(1)
        
    categories = []
    items = []
    
    # Get unique categories and assign sort order
    unique_cats = df['Category'].unique()
    cat_map = {}
    for idx, cat_name in enumerate(unique_cats):
        cat_id = f"cat:{cat_name.lower().replace('/','-').replace(' ','-').replace('--','-').strip()}"
        cat_map[cat_name] = cat_id
        categories.append({
            "id": cat_id,
            "name": cat_name,
            "sortOrder": idx + 1
        })
        
    for idx, row in df.iterrows():
        item_name = clean_name(row['Item'])
        cat_name = clean_name(row['Category'])
        price_raw = row['Price (PKR)']
        
        # Override Decaf price
        if item_name.lower() == 'decaf':
            price = 600
        else:
            try:
                price = float(price_raw)
            except ValueError:
                price = 0.0
                
        desc = generate_description(item_name, cat_name)
        item_id = f"dish:tcc-{idx+1}"
        
        items.append({
            "id": item_id,
            "categoryId": cat_map[cat_name],
            "name": item_name,
            "description": desc,
            "price": price,
            "available": True
        })
        
    output = {
        "categories": categories,
        "items": items
    }
    
    print(json.dumps(output, indent=2))

if __name__ == '__main__':
    main()
